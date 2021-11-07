const path = require('path');
const _ = require('lodash');
const { getModelByQuery } = require('@stackbit/sdk');


module.exports = {
    matchObjectsToModels
};

function log(message) {
    console.log(`[sourcebit-source-filesystem] ${message}`);
}

function logError(message) {
    console.error(`[sourcebit-source-filesystem] ${message}`);
}

function matchObjectsToModels(objects, models, { pageObjectsPredicate, dataObjectsPredicate, pageLayoutKey, dataTypeKey, objectIdKeyPath, objectFileKeyPath, source, mergeDataModels, logMatchedModels }) {
    const modelsByName = _.keyBy(models, 'name');
    const pageModels = _.filter(models, _.matches({'type': 'page'}));
    const dataModels = _.filter(models, _.matches({'type': 'data'}));

    log('matching files to models...');
    const modelsByObjectIds = _.reduce(objects, (accum, object) => {
        if (pageObjectsPredicate(object)) {
            const { model, error } = getModelByQuery({
                filePath: _.get(object, objectFileKeyPath),
                type: _.get(object, pageLayoutKey),
                modelTypeKeyPath: 'layout'
            }, pageModels);
            if (error) {
                logError(error.message);
            } else {
                const objectId = _.get(object, objectIdKeyPath);
                accum[objectId] = model;
            }
        } else if (dataObjectsPredicate(object)) {
            const { model, error } = getModelByQuery({
                filePath: _.get(object, objectFileKeyPath),
                type: _.get(object, dataTypeKey),
                modelTypeKeyPath: 'name'
            }, dataModels);
            if (error) {
                logError(error.message);
            } else {
                const objectId = _.get(object, objectIdKeyPath);
                accum[objectId] = model;
            }
        }
        return accum;
    }, {});

    log(`${_.size(modelsByObjectIds)} of ${_.size(objects)} files were matched to models`);
    if (logMatchedModels) {
        const modelNames = _.uniq(_.map(modelsByObjectIds, 'name'));
        const longestModelName = _.maxBy(modelNames, _.size);
        log('matched models:' + _.map(modelsByObjectIds, (model, objectId) => '\n  ' + _.padEnd(model.name, longestModelName.length) + ' : ' + objectId).join(''));
    }

    objects = _.map(objects, object => {
        const objectId = _.get(object, objectIdKeyPath);
        const model = _.get(modelsByObjectIds, objectId);
        // if model for object was not found, return the original object without modifying it
        if (!model) {
            return object;
        }
        const filePath = _.get(object, objectFileKeyPath);
        return addMetadata(object, model, { filePath, modelsByName });
    });
    if (mergeDataModels) {
        const dataObjects = _.filter(objects, _.matches({__metadata: {modelType: 'data'}}));
        const mergedDataObject = mergeDataObjects(dataObjects, objectFileKeyPath, source);
        objects = _.concat(objects, mergedDataObject);
    }
    return objects;
}

function addMetadata(data, model, { filePath, modelsByName, dataFieldPath = [], modelFieldPath = [] }) {
    const fields = _.get(model, 'fields', {});
    if (_.isEmpty(modelFieldPath)) {
        modelFieldPath = [model.name];
    }
    const location = `file: ${filePath}:${dataFieldPath.join('.')}, model: stackbit.yaml:models.${modelFieldPath.join('.')}`;
    if (!_.isPlainObject(data)) {
        logError(`value must be an object, ${location}`);
        return data;
    }
    data = _.mapValues(data, (fieldValue, fieldName) => {
        const fieldModel = _.find(fields, {name: fieldName});
        if (!fieldModel) {
            return fieldValue;
        }
        return mapObjectField(fieldValue, fieldModel, {
            filePath,
            modelsByName,
            dataFieldPath: _.concat(dataFieldPath, fieldName),
            modelFieldPath: _.concat(modelFieldPath, 'fields', fieldName)
        });
    });
    return _.assign(
        {}, data,
        {
            __metadata: _.assign(
                {},
                _.get(data, '__metadata'),
                _.omitBy({
                    modelType: model.type,
                    modelName: _.get(model, 'name', null),
                    modelLabel: _.get(model, 'label', null),
                    urlPath: model.type === 'page' ? urlPathFromFilePath(filePath) : null
                }, _.isNil)
            )
        }
    );
}

function mapObjectField(fieldValue, fieldModel, { filePath, modelsByName, dataFieldPath, modelFieldPath }) {
    const location = `file: ${filePath}:${dataFieldPath.join('.')}, model: stackbit.yaml:models.${modelFieldPath.join('.')}`;
    if (fieldModel.type === 'object') {
        return addMetadata(fieldValue, fieldModel, { filePath, modelsByName, dataFieldPath, modelFieldPath });
    } else if (fieldModel.type === 'model') {
        if (!_.has(fieldModel, 'models') || !_.isArray(fieldModel.models) || fieldModel.models.length < 1) {
            logError(`field of type 'model' must have 'models' property with array having at least one model name, ${location}`);
            return fieldValue;
        }
        let modelName;
        if (fieldModel.models.length === 1) {
            modelName = _.head(fieldModel.models);
            if (!_.has(modelsByName, modelName)) {
                logError(`the 'models' array of the field of type 'model' must include the names of existing models, ${location}`);
                return fieldValue;
            }
        } else {
            if (!_.has(fieldValue, 'type')) {
                logError(`object referenced by a field of type 'model' having more than one model in 'models' array, must have 'type' property specifying the name of the object's model, ${location}`);
                return fieldValue;
            }
            modelName = fieldValue.type;
            if (!_.has(modelsByName, modelName)) {
                logError(`the value of the 'type' property of the object referenced by a field of type 'model' must be the name of an existing model, ${location}`);
                return fieldValue;
            }
        }
        return addMetadata(fieldValue, modelsByName[modelName], {filePath, modelsByName, dataFieldPath, modelFieldPath: []});
    } else if (fieldModel.type === 'reference') {
        // generally, reference fields will be processed as global objects
        // this is for backward compatibility when data includes the data of referenced object
        if (_.has(fieldValue, 'type') && _.has(modelsByName, fieldValue.type)) {
            return addMetadata(fieldValue, modelsByName[fieldValue.type], {filePath, modelsByName, dataFieldPath, modelFieldPath: []});
        }
        return fieldValue;
    } else if (fieldModel.type === 'list') {
        if (!_.isArray(fieldValue)) {
            logError(`the value referenced by a field of type 'list' must be an array, ${location}`);
            return fieldValue;
        }
        // default items.type of a list is 'string'
        const itemModel = _.get(fieldModel, 'items', {type: 'string'});
        modelFieldPath = _.concat(modelFieldPath, ['items']);
        return _.map(fieldValue, (item, idx) => {
            return mapObjectField(item, itemModel, { filePath, modelsByName, dataFieldPath: _.concat(dataFieldPath, [idx]), modelFieldPath })
        });
    } else {
        return fieldValue;
    }
}

function urlPathFromFilePath(filePath) {
    const pathObject = path.parse(filePath);
    const parts = _.compact(pathObject.dir.split(path.sep));
    if (pathObject.name !== 'index') {
        parts.push(pathObject.name);
    }
    const urlPath = parts.join('/').toLowerCase();
    return  '/' + urlPath;
}

function mergeDataObjects(objects, objectFileKeyPath, source) {
    objects = _.sortBy(objects, objectFileKeyPath);
    return _.reduce(objects, (accum, object) => {
        const filePath = _.get(object, objectFileKeyPath);
        const pathObject = path.parse(filePath);
        const propPath = _.compact(pathObject.dir.split(path.sep).concat(pathObject.name));
        _.set(accum, propPath, object);
        return accum;
    }, {
        __metadata: {
            id: `${source}:data`,
            source: source
        }
    });
}
