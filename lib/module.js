/*jslint stupid: true, regexp: true, nomen: true */
/*
Copyright (c) 2012, Yahoo! Inc. All rights reserved.
Code licensed under the BSD License:
http://yuilibrary.com/license/
*/
var Stack = require('./stack').Stack,
    path = require('path'),
    fs = require('fs'),
    mkdirp = require('mkdirp'),
    log = require('./log'),
    noop = function () {},
    tasks = require('./tasks'),
    lint = require('yui-lint'),
    which = require('which').sync,
    Queue = require('gear').Queue,
    Registry = require('gear').Registry,
    registry,
    ncpOptions = {
        filter: function (name) {
            var base = path.basename(name);
            if (base.indexOf('.') === 0 || base === 'node_modules') {
                return false;
            }
            return true;
        }
    },
    cName = {
        compressor: 'YUICompressor',
        jsminify: 'UglifyJS'
    },
    coverageType = 'yuitest',
    compressorFn = 'jsminify',
    compressorConfig = {
        callback: function (e) {
            log.err('compression failed');
            console.log('       ' + String(e.message).trim() + log.color(' // line ' + e.line + ', pos ' + e.col, 'white'));
            log.error('dropped the clutch, build failed');
        },
        config: {
            mangle: true,
            squeeze: true,
            semicolon: false,
            lift_vars: true,
            mangle_toplevel: true,
            no_mangle_functions: true,
            max_line_length: 6000
        }
    },
    configCompressor = function (options) {
        if (options.compressor) {
            compressorFn = 'compressor';
            compressorConfig = {
                'disable-optimizations': true,
                'preserve-semi': true,
                'line-break': 6000
            };
        } else {
            compressorConfig.semi = options.semi;
        }
    },
    strictMode = false,
    defaultLint = lint.defaults,
    _exec = require('child_process').exec,
    _execFile = require('child_process').execFile,
    rimraf = require('rimraf'),
    ncp = require('ncp').ncp,
    jslintConfig = {},
    lintFail = false,
    lintSTDError = false,
    cacheBuild = false,
    replaceOptions = [],
    cssLint = {
        config: null,
        callback: function (info) {
            var file = info.name.replace(process.cwd(), ''),
                lint = info.csslint,
                fn = 'log',
                counter = 0;
            if (lintSTDError) {
                fn = 'error';
            }
            if (!!lint && lint.length) {
                log.err(file + ' contains ' + lint.length + ' lint errors');

                lint.forEach(function (item) {
                    counter = counter + 1;
                    console[fn]('   #' + counter + ': ' + log.color('[' + item.type + ']', 'red') + ' ' + log.color(item.message, 'yellow'));
                    if (item.evidence) {
                        console[fn]('       ' + String(item.evidence).trim() + log.color(' // line ' + item.line + ', pos ' + item.col, 'white'));
                    }
                });
                if (lintFail) {
                    log.error('lint failed, aborting build');
                }
            } else {
                log.info('css lint passed for ' + file);
            }
        }
    },
    setJSLint = function () {
        var i;
        jslintConfig = {
            config: {},
            callback: function (linted) {
                var messages = linted.jslint || [],
                    counter = 0,
                    fn = 'log';
                if (lintSTDError) {
                    fn = 'error';
                }
                if (messages.length) {
                    log.err(linted.name + ' contains ' + messages.length + ' lint errors');
                    messages.forEach(function (item) {
                        if (item && item.reason) {
                            counter = counter + 1;
                            console[fn]('   #' + counter + ': ' + log.color(item.reason, 'yellow'));
                            if (item.evidence) {
                                console[fn]('       ' + String(item.evidence).trim() + log.color(' // line ' + item.line + ', pos ' + item.character, 'white'));
                            }
                        }
                    });
                    if (lintFail) {
                        log.error('lint failed, aborting build');
                    }
                }
            }
        };
        for (i in defaultLint) {
            if (defaultLint.hasOwnProperty(i)) {
                jslintConfig.config[i] = defaultLint[i];
            }
        }
    },
    resolve = function (items, dir) {
        var i = [];
        if (!Array.isArray(items)) {
            return null;
        }
        items.forEach(function (file, key) {
            var d = dir;
            if (file.indexOf(d + '/') === 0 || file.indexOf('./' + d) === 0) {
                d = '';
            }
            i[key] = path.join(process.cwd(), d, file);
        });
        return i;
    },
    stringify = function (config) {
        config = config || {};
        //This may need tweaked..
        if (config.after) {
            delete config.after;
        }
        var str = JSON.stringify(config);
        str = str.replace(/:/g, ': ').replace(/,/g, ', ');
        if (str === '{}' || str === '[]') {
            str = '';
        }
        if (str !== '') {
            str = ', ' + str;
        }
        return str;
    },
    buildDir = path.join(process.cwd(), '../../build'),
    loggerRegex = /^.*?(?:logger|Y.log).*?(?:;|\).*;|(?:\r?\n.*?)*?\).*;).*;?.*?\r?\n/mg,
    metaData = {},
    exists = fs.existsSync || path.existsSync;



registry = new Registry({
    dirname: path.resolve(__dirname, '../', 'node_modules', 'gear-lib', 'lib')
});


registry.load({
    tasks: tasks
});


exports.loggerRegex = loggerRegex;
exports.buildDir = buildDir;

var buildCSS = function (mod, name, callback) {
    var queue = new Queue({
        logger: log,
        registry: registry
    });

    queue.read(resolve(mod.cssfiles, 'css'))
        .concat()
        .cssstamp({
            stamp: '/* YUI CSS Detection Stamp */\n#yui3-css-stamp.' + name + ' { display: none; }'
        })
        .replace(replaceOptions);

    if (defaultLint) {
        queue.csslint(cssLint);
    }

    queue.md5check({
        error: cacheBuild,
        current: path.join(buildDir, name, name + '.css')
    })
        .check()
        .write(path.join(buildDir, name, name + '.css'))
        .cssmin()
        .check()
        .write(path.join(buildDir, name, name + '-min.css'))
        .run(function (err, result) {
            if (err) {
                if (/file has not changed/.test(err)) {
                    log.warn(name + ': ' + err);
                } else {
                    log.err(name + ': ' + err);
                }
            }
            callback();
        });

};

exports.css = buildCSS;

var buildJS = function (mod, name, callback) {

    var queue = new Queue({
        logger: log,
        registry: registry
    }),
        bail = false,
        modName = mod.name || name,
        fileName = mod.basefilename || name,
        replacers = [],
        regex = (typeof mod.regex !== 'undefined') ? mod.regex : loggerRegex;

    queue.read(resolve(mod.jsfiles, 'js'))
        .concat();

    if (mod.stamp) {
        queue.jsstamp({
            strict: strictMode,
            prefix: "YUI.add('" + modName + "', function (Y, NAME) {\n\n",
            postfix: "\n\n}, '@VERSION@'" + stringify(mod.config) + ");\n"
        });
    }
    queue.replace(replaceOptions);

    queue.wrap({
        prepend: resolve(mod.prependfiles, 'js'),
        append: resolve(mod.appendfiles, 'js')
    });

    if (mod.replace) {
        Object.keys(mod.replace).forEach(function (key) {
            replacers.push({
                regex: key,
                replace: mod.replace[key]
            });
        });
        queue.replace(replacers);
    }
    if (defaultLint) {
        queue.jslint(jslintConfig);
    }

    queue.md5check({
        error: cacheBuild,
        current: path.join(buildDir, fileName, fileName + '-debug.js')
    })
        .check()
        .write(path.join(buildDir, fileName, fileName + '-debug.js'));

    if (regex) {
        queue.replace({
            regex: regex
        }); // Strip Y.log's
    }

    queue.log('writing RAW file')
        .check()
        .write(path.join(buildDir, fileName, fileName + '.js'))
        .log('compressing ' + path.join(fileName, fileName + '.js with ' + cName[compressorFn]));

    queue[compressorFn](compressorConfig)
        .log('writing -min file')
        .check()
        .write(path.join(buildDir, fileName, fileName + '-min.js'))
        .run(function (err, result) {
            if (err) {
                if (/file has not changed/.test(err)) {
                    log.warn(name + ': ' + err);
                } else {
                    if (/ENOENT/.test(err)) {
                        log.error('Failed to open file: ' + err.path);
                    }
                    log.err(name + ': ' + err);
                }
            }
            callback(err, result);
        });

};

exports.js = buildJS;

var buildCoverage = function (mod, name, callback) {
    log.info('shifting for coverage');
    var queue = new Queue({
        logger: log,
        registry: registry
    }),
        fileName = mod.basefilename || name;

    queue.read([
        path.join(buildDir, fileName, fileName + '.js')
    ])
        .log('coverage file read, starting coverage for: ' + fileName + '/' + fileName + '.js')
        .coverage({
            type: coverageType,
            charset: 'utf8',
            name: 'build/' + fileName + '/' + fileName + '.js'
        })
        .replace(replaceOptions)
        .check()
        .log('writing coverage file to ' + fileName + '/' + fileName + '-coverage.js')
        .write(path.join(buildDir, fileName, fileName + '-coverage.js'))
        .run(function (err, result) {
            if (err) {
                log.err('coverage: ' + err);
            }
            callback();
        });

};

exports.coverage = buildCoverage;

var buildLang = function (mod, name, callback) {
    var langs = mod.config.lang,
        stack = new Stack();

    langs.unshift('');
    log.info('shifting ' + langs.length + ' langs for ' + name);

    langs.forEach(function (lang) {
        var queue = new Queue({
                logger: log,
                registry: registry
            }),
            modName = name + (lang ? '_' + lang : ''),
            fileName = modName + '.js',
            strings = fs.readFileSync(path.join(process.cwd(), 'lang', fileName), 'utf8');

        queue.read([path.join(__dirname, '../files/langtemplate.txt')])
            .replace(replaceOptions)
            .replace([
                {
                    regex: /@LANG_MODULE@/,
                    replace: 'lang/' + modName
                },
                {
                    regex: /@YUIVAR@/,
                    replace: 'Y'
                },
                {
                    regex: /@MODULE@/,
                    replace: name
                },
                {
                    regex: /@LANG@/,
                    replace: lang
                },
                {
                    regex: /@STRINGS@/,
                    replace: strings
                },
                {
                    regex: /@LANG_DETAILS@/,
                    replace: ''
                }
            ]);

        queue[compressorFn](compressorConfig)
            .check()
            .write(path.join(buildDir, name, 'lang', fileName))
            .run(stack.add(function (err, result) {
                if (err) {
                    log.err('lang: ' + err);
                } else {
                    log.info('shifted lang for ' + name);
                }
            }));

    });

    stack.done(callback);

};

exports.lang = buildLang;

var copyAssets = function (mod, name, callback) {
    var from = path.join(process.cwd(), 'assets'),
        to = path.join(buildDir, name, 'assets');

    if (exists(from)) {
        log.info('shifting assets for ' + name);
        ncp(from, to, ncpOptions, callback);
    } else {
        callback();
    }
};

var buildSkin = function (mod, name, callback) {
    log.info('shifting skin for ' + name);

    var stack = new Stack(),
        subMod = '',
        from = path.join(process.cwd(), 'assets'),
        to = path.join(buildDir, name, 'assets');

    if (exists(path.join(process.cwd(), 'assets', name))) {
        log.info('found a subskin, shifting for ' + name);
        from = path.join(process.cwd(), 'assets', name);
        subMod = name;
    }

    if (exists(from)) {
        ncp(from, to, ncpOptions, stack.add(function () {
            //Get list of Skins
            fs.readdir(path.join(process.cwd(), 'assets', subMod, 'skins'), stack.add(function (err, skins) {
                if (err) {
                    console.log(err);
                    log.error('skin files are not right!');
                }

                //Walk the skins and write them out
                skins.forEach(function (skinName) {
                    if (skinName.indexOf('.') === 0) {
                        return;
                    }
                    //Write the full skin file with core
                    var queue = new Queue({
                        logger: log,
                        registry: registry
                    }),
                        base = path.join(process.cwd(), 'assets', subMod, 'skins', skinName);

                    queue.read([
                        path.resolve(base, '../../', name + '-core.css'),
                        path.join(base, name + '-skin.css')
                    ])
                        .log('copying assets to skin for ' + skinName)
                        .concat();
                    if (defaultLint) {
                        queue.csslint(cssLint);
                    }

                    queue.cssstamp({
                        stamp: '/* YUI CSS Detection Stamp */\n#yui3-css-stamp.skin-' + skinName + '-' + name + ' { display: none; }'
                    })
                        .replace(replaceOptions)
                        .cssmin()
                        .check()
                        .log('writing skin file with core wrapper')
                        .write(path.join(buildDir, name, 'assets', 'skins', skinName, name + '.css'))
                        .run(stack.add(function (err) {
                            if (err) {
                                log.err(err);
                                if (err.code === 'ENOENT') {
                                    log.error('skin file is missing: ' + err.path);
                                }
                            }

                            //Write the skin file without core
                            var Rqueue = new Queue({
                                    logger: log,
                                    registry: registry
                                });

                            Rqueue.read([
                                path.join(base, name + '-skin.css')
                            ])
                                .check()
                                .log('writing skin file without core wrapper')
                                .write(path.join(buildDir, name, 'assets', 'skins', skinName, name + '-skin.css'))
                                .run(stack.add(function () {
                                }));
                        }));
                });

            }));
        }));
    }

    stack.done(callback);

};

exports.skin = buildSkin;

var buildCopy = function (mod, name, callback) {
    log.info('shifting a copy');
    mod.copy.forEach(function (value, key) {
        mod.copy[key] = [
            path.resolve(value[0]),
            path.resolve(value[1])
        ];
    });

    var copy = function () {
        var item = mod.copy.shift(),
            from,
            to;

        if (!item) {
            log.info('down shifting the copy');
            return callback();
        }
        from = item[0];
        to = item[1];

        rimraf(to, function () {
            log.info('copying from ' + from + ' to ' + to);
            var stat = fs.statSync(from),
                fromS,
                toS,
                toDir;

            if (stat.isDirectory()) {
                ncp(from, to, ncpOptions, function () {
                    copy();
                });
            } else {
                if (stat.isFile()) {
                    toDir = path.dirname(to);
                    if (!exists(toDir)) {
                        mkdirp.sync(toDir);
                    }
                    fromS = fs.createReadStream(from);
                    toS = fs.createWriteStream(to);
                    fromS.pipe(toS);
                    fromS.once('end', copy);
                }
            }
        });
    };

    copy();

};

exports.copy = buildCopy;

var setReplacers = function (options) {
    Object.keys(options).forEach(function (k) {
        var key, o;
        if (k.indexOf('replace-') === 0) {
            key = k.replace('replace-', '').toUpperCase();
            o = {
                regex: '@' + key + '@',
                replace: options[k]
            };
            replaceOptions.push(o);
        }
    });
};

var build = function (mod, name, options, callback) {
    var stack = new Stack();

    if (options.lint === false) {
        defaultLint = options.lint;
        log.warn('skipping jslint, you better be linting your stuff with something!');
    } else {
        defaultLint = lint[options.lint];
        log.info('using ' + options.lint + ' jslint setting');
        setJSLint();
    }

    configCompressor(options);

    cacheBuild = options.cache;
    setReplacers(options);
    coverageType = (options.istanbul) ? 'istanbul' : 'yuitest';

    if (options.strict) {
        strictMode = true;
    }
    if (options.fail) {
        lintFail = true;
    }
    if (options['lint-stderr']) {
        lintSTDError = true;
    }
    mod.stamp = options.jsstamp;

    if (mod.jsfiles) {
        exports.js(mod, name, stack.add(function (err, result) {
            if (err) {
                log.warn('skipping coverage file build due to previous build error');
            } else {
                if (options.coverage) {
                    exports.coverage(mod, name, stack.add(noop));
                }
                if ((mod.config && mod.config.skinnable) || mod.skinnable) {
                    exports.skin(mod, name, stack.add(noop));
                } else if (mod.assets) {
                    copyAssets(mod, name, stack.add(noop));
                }
                if (mod.config.lang) {
                    exports.lang(mod, name, stack.add(noop));
                }
            }
        }));
    }
    if (mod.cssfiles) {
        exports.css(mod, name, stack.add(noop));
    }

    if (mod.copy) {
        exports.copy(mod, name, stack.add(noop));
    }

    stack.done(function () {
        if (!stack.complete) {
            stack.complete = true;
            callback();
        }
    });
};

var exec = function (exec, name, callback) {
    log.info('found an exec, shifting the build');
    var stack = new Stack();

    if (typeof name === 'function') {
        callback = name;
        name = 'global';
    }

    exec.forEach(function (cmd) {
        log.info('executing ' + cmd);
        var e = _exec, p, child, other,
            cmdName = cmd.split(' ')[0];
        if (path.extname(cmdName) === '.js') {
            e = _execFile;
        } else {
            if (cmdName === 'shifter') {
                //Fixing the call to shifter..
                p = cmd.split(' ');
                p[0] = which('shifter');
                cmd = p.join(' ');
            } else {
                p = cmd.split(' ');
                other  = which(p[0]);
                if (other) {
                    p[0] = other;
                    cmd = p.join(' ');
                }
                log.info(cmd);
                log.warn('THIS MAY NOT BE CROSS PLATFORM!');
            }
        }
        child = e(cmd, {
            cwd: process.cwd()
        }, stack.add(function (error, stdout, stderr) {
            if (stderr) {
                log.err('start output from ' + cmd + '\n');
                console.error(stderr);
                log.err('end output from ' + cmd);
            } else {
                log.info('start output from ' + cmd + '\n');
                console.log(stdout);
                log.info('end output from ' + cmd);
            }
        }));
    });

    stack.done(callback);
};

exports.exec = exec;

exports.build = function (mod, name, options, callback) {
    var end = function () {
        if (mod.postexec) {
            exec(mod.postexec, name, callback);
        } else {
            callback();
        }
    };
    if (mod.exec) {
        exec(mod.exec, name, function () {
            build(mod, name, options, end);
        });
    } else {
        build(mod, name, options, end);
    }
};

/*
    Rollups are sync since they are rolling up a build we need to make sure the builds are
    complete before we run the next that might need it.
*/


var _rollup = function (mod, name, options, callback) {
    var queue = new Queue({
        registry: registry,
        logger: log
    }),
        modName = mod.name || name,
        fileName = mod.basefilename || name,
        regex = (typeof mod.regex !== 'undefined') ? mod.regex : loggerRegex,
        files = [];

    mod.files.forEach(function (file) {
        files.push(path.join(process.cwd(), '../../build/', file, file + '-debug.js'));
    });

    queue.read(files)
        .concat()
        .jsstamp({
            postfix: "YUI.add('" + modName + "', function (Y, NAME) {" + (options.strict ? '"use strict"; ' : "") + "}, '@VERSION@'" + stringify(mod.config) + ");\n"
        })
        .replace(replaceOptions)
        .log('writing rollup file ' + path.join(fileName, fileName + '-debug.js'))
        .check()
        .write(path.join(buildDir, fileName, fileName + '-debug.js'));

    if (regex) {
        queue.replace({
            regex: regex
        }); // Strip Y.log's
    }

    if (defaultLint) {
        queue.jslint(jslintConfig);
    }

    queue.log('linting done, writing ' + path.join(fileName, fileName + '.js'))
        .check()
        .write(path.join(buildDir, fileName, fileName + '.js'))
        .log('compressing ' + path.join(fileName, fileName + '.js with ' + cName[compressorFn]));

    queue[compressorFn](compressorConfig)
        .check()
        .log('compressing done, writing ' + path.join(fileName, fileName + '-min.js'))
        .write(path.join(buildDir, fileName, fileName + '-min.js'))
        .run(function (err, result) {
            if (err) {
                log.error(name + ' rollup: ' + err);
            }
            callback();
        });
};

exports.rollup = function (mods, callback) {
    if (!mods || !mods.length) {
        return callback();
    }

    //No caching for rollups
    cacheBuild = false;

    var item = mods.shift(),
        options,
        name,
        mod,
        i;
    if (item) {
        name = item.mod.name || item.name;
        options = item.options;
        mod = item.mod;
        setReplacers(options);

        configCompressor(options);

        if (mod.build) {
            log.info('found a sub build, down shifting');
            mod.build.name = mod.build.name || name;
            for (i in mod) {
                if (mod.hasOwnProperty(i)) {
                    if (i !== 'files' && i !== 'build') {
                        if (!mod.build[i]) {
                            mod.build[i] = mod[i];
                        }
                    }
                }
            }
            build(mod.build, name, options, function () {
                delete mod.build;
                log.info('sub build complete, up shifting to rollup');
                _rollup(mod, name, options, function () {
                    exports.rollup(mods, callback);
                });
            });
        } else {
            _rollup(mod, name, options, function () {
                exports.rollup(mods, callback);
            });
        }
    } else {
        callback();
    }
};

