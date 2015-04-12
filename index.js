var JSONStream = require('JSONStream');
var defined = require('defined');
var through = require('through2');
var umd = require('umd');

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var combineSourceMap = require('combine-source-map');

var defaultPreludePath = path.join(__dirname, '_prelude.js');
var defaultPrelude = fs.readFileSync(defaultPreludePath, 'utf8');

var cache = {};

function newlinesIn(src) {
  if (!src) return 0;
  var newlines = src.match(/\n/g);

  return newlines ? newlines.length : 0;
}

function hash(str) {
    return crypto.createHash('sha1').update(str).digest('hex');
}

module.exports = function (opts) {
    if (!opts) opts = {};
    var parser = opts.raw ? through.obj() : JSONStream.parse([ true ]);
    var stream = through.obj(
        function (buf, enc, next) { parser.write(buf); next() },
        function () { parser.end() }
    );
    parser.pipe(through.obj(write, end));
    stream.standaloneModule = opts.standaloneModule;
    stream.hasExports = opts.hasExports;
    
    var first = true;
    var entries = [];
    var basedir = defined(opts.basedir, process.cwd());
    var prelude = opts.prelude || defaultPrelude;
    var preludePath = opts.preludePath ||
        path.relative(basedir, defaultPreludePath).replace(/\\/g, '/');
    
    var evaled = opts.debug === 'eval';
    var lineno = 1 + newlinesIn(prelude);
    var sourcemap;
    
    return stream;
    
    function write (row, enc, next) {
        if (first && opts.standalone) {
            var pre = umd.prelude(opts.standalone).trim();
            stream.push(Buffer(pre + 'return '));
        }
        else if (first && stream.hasExports) {
            var pre = opts.externalRequireName || 'require';
            stream.push(Buffer(pre + '='));
        }
        if (first) stream.push(Buffer(prelude + '({'));
        
        if (!evaled && row.sourceFile && !row.nomap) {
            if (!sourcemap) {
                sourcemap = combineSourceMap.create();
                sourcemap.addFile(
                    { sourceFile: preludePath, source: prelude },
                    { line: 0 }
                );
            }
            sourcemap.addFile(
                { sourceFile: row.sourceFile, source: row.source },
                { line: lineno }
            );
        }
        
        var wrappedModule;
        if (!evaled) {
            wrappedModule = [
                'function(require,module,exports){\n',
                combineSourceMap.removeComments(row.source),
                '\n}'
            ].join('');
        } else {
            var key = row.sourceFile + '::' + row.nomap + '::' + hash(row.source);
            if (key in cache) {
                wrappedModule = cache[key];
            } else {
                if (row.sourceFile && !row.nomap) {
                    sourcemap = combineSourceMap.create();
                    sourcemap.addFile(
                        { sourceFile: row.sourceFile, source: row.source },
                        { line: 1 }
                    );
                }
                wrappedModule = cache[key] = [
                    'eval(',
                        JSON.stringify(
                            '(function(require,module,exports){\n' +
                            combineSourceMap.removeComments(row.source) +
                            (sourcemap ? '\n' + sourcemap.comment() : '') +
                            '\n})'
                        ),
                    ')'
                ].join('');
                sourcemap = null;
            }
        }
        
        var wrappedSource = [
            (first ? '' : ','),
            JSON.stringify(row.id),
            ':[',
            wrappedModule,
            ',{' + Object.keys(row.deps || {}).sort().map(function (key) {
                return JSON.stringify(key) + ':'
                    + JSON.stringify(row.deps[key])
                ;
            }).join(',') + '}',
            ']'
        ].join('');

        stream.push(Buffer(wrappedSource));
        lineno += newlinesIn(wrappedSource);
        
        first = false;
        if (row.entry && row.order !== undefined) {
            entries[row.order] = row.id;
        }
        else if (row.entry) entries.push(row.id);
        next();
    }
    
    function end () {
        if (first) stream.push(Buffer(prelude + '({'));
        entries = entries.filter(function (x) { return x !== undefined });
        
        stream.push(Buffer('},{},' + JSON.stringify(entries) + ')'));
        
        if (opts.standalone) {
            stream.push(Buffer(
                '(' + JSON.stringify(stream.standaloneModule) + ')'
                + umd.postlude(opts.standalone)
            ));
        }
        
        if (sourcemap) {
            var comment = sourcemap.comment();
            if (opts.sourceMapPrefix) {
                comment = comment.replace(
                    /^\/\/#/, function () { return opts.sourceMapPrefix }
                )
            }
            stream.push(Buffer('\n' + comment + '\n'));
        }
        if (!sourcemap && !opts.standalone) stream.push(Buffer(';\n'));

        stream.push(null);
    }
};
