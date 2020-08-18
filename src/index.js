const chokidar = require('chokidar');
const fse = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const { loadModels } = require('@stackbit/schema');
const { parseFile, mapPromise, readDirRecursively } = require('@stackbit/utils');
const { matchObjectsToModels } = require('./models-matcher');


const SOURCE = 'sourcebit-source-filesystem';
module.exports.name = SOURCE;

module.exports.options = {
    dataProperty: {
        default: 'fileObjects'
    },
    watch: {
        default: false,
        runtimeParameter: "watch"
    }
};

function log(message) {
    console.log(`[${SOURCE}] ${message}`);
}

module.exports.bootstrap = async ({ setPluginContext, options, refresh }) => {
    let { watch, sources = [] } = options;

    const stackbitYamlFileName = 'stackbit.yaml';
    const stackbitYamlPath = path.resolve(stackbitYamlFileName);
    const stackbitYamlExists = await fse.pathExists(stackbitYamlPath);
    if (stackbitYamlExists) {
        log('loading stackbit.yaml and models...');
        const { models, stackbitYaml } = await loadStackbitYaml(stackbitYamlPath)
        setPluginContext({ models, stackbitYaml });

        // if 'sources' were not specified, use 'pagesDir' and 'dataDir' from stackbit.yaml
        if (_.isEmpty(sources)) {
            const pagesDir = _.get(stackbitYaml, 'pagesDir', '');
            const dataDir = _.get(stackbitYaml, 'dataDir', '');
            sources = [
                { name: 'pages', path: pagesDir },
                { name: 'data', path: dataDir }
            ];
        }
    }

    log('loading content files...');
    const files = await readFiles(sources);
    log(`loaded ${files.length} files`);

    setPluginContext({ files });

    if (watch) {
        let changedFilePaths = [];

        // don't call refresh on every file change, as multiple files could be written at once.
        // instead, debounce the update function for 50ms, up to 200ms
        const debouncedUpdate = _.debounce(async () => {
            log(`reload files and refresh sourcebit plugins...`);

            const filePathsCopy = changedFilePaths.slice();
            changedFilePaths = [];

            if (filePathsCopy.includes(stackbitYamlFileName)) {
                log('reloading stackbit.yaml and models...');
                const { models, stackbitYaml } = await loadStackbitYaml(stackbitYamlPath)
                setPluginContext({ models, stackbitYaml });
            }

            if (_.some(filePathsCopy, filePath => filePath !== stackbitYamlFileName)) {
                log('reloading content files...');
                const files = await readFiles(sources);
                log(`loaded ${files.length} files`);
                setPluginContext({ files });
            }

            refresh();
        }, 50, {maxWait: 200});

        const update = async (eventName, filePath) => {
            log(`file '${filePath}' has been ${eventName}, reloading files...`);
            changedFilePaths.push(filePath);
            await debouncedUpdate();
        };

        const watchPaths = _.map(sources, _.property('path'));
        if (stackbitYamlExists) {
            watchPaths.push(stackbitYamlFileName);
        }
        const watcher = chokidar.watch(watchPaths, { ignoreInitial: true });
        watcher.on('add', _.partial(update, 'added'));
        watcher.on('change', _.partial(update, 'changed'));
        watcher.on('unlink', _.partial(update, 'removed'));
    }
};

module.exports.transform = ({ data, getPluginContext, options }) => {
    const context = getPluginContext();
    let objects = context.files;
    if (context.stackbitYaml && context.models) {
        objects = matchObjectsToModels(context.files, context.models, {
            pageObjectsPredicate: _.matches({__metadata: {sourceName: 'pages'}}),
            dataObjectsPredicate: _.matches({__metadata: {sourceName: 'data'}}),
            pageLayoutKey: ['frontmatter', _.get(context, 'stackbitYaml.pageLayoutKey', 'layout')],
            dataTypeKey: _.get(context, 'stackbitYaml.objectTypeKey', 'type'),
            objectIdKeyPath: '__metadata.id',
            objectFileKeyPath: '__metadata.relSourcePath',
            source: SOURCE,
            mergeDataModels: _.get(options, 'mergeDataModels', true),
            logMatchedModels: _.get(options, 'logMatchedModels', false)
        });
    }
    return _.assign({}, data, {
        objects: data.objects.concat(objects)
    });
};

async function loadStackbitYaml(stackbitYamlPath) {
    log('loading stackbit.yaml...');
    const stackbitYaml = await parseFile(stackbitYamlPath);
    const models = loadModels(stackbitYaml.models);
    log(`loaded stackbit.yaml, found ${models.length} models`);
    return { models, stackbitYaml };
}

async function readFiles(sources) {
    const result = await mapPromise(sources, async ({ name, path: sourcePath }) => {
        const absProjectPath = process.cwd();
        const absSourcePath = path.resolve(sourcePath);
        let filePaths = await readDirRecursively(absSourcePath);
        filePaths = _.filter(filePaths, filePath => {
            const ext = path.extname(filePath).substring(1);
            return ['yml', 'yaml', 'json', 'toml', 'md'].includes(ext);
        }).sort();
        return mapPromise(filePaths, async filePath => {
            const absFilePath = path.join(absSourcePath, filePath);
            const data = await parseFile(absFilePath);
            const relProjectPath = path.relative(absProjectPath, absFilePath);
            const relSourcePath = path.relative(absSourcePath, absFilePath);
            return _.assign({
                __metadata: {
                    id: `${relProjectPath}`,
                    source: SOURCE,
                    sourceName: name,
                    sourcePath: sourcePath,
                    relSourcePath: relSourcePath,
                    relProjectPath: relProjectPath
                }
            }, data);
        });
    });
    return _.chain(result).flatten().value();
}
