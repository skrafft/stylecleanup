const parser = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const fs = require('fs')
const path = require('path')
const glob = require('glob')

const isStyleSheetCreate = path => {
  // TODO could potentially check that this was imported from aphrodite, but
  // maybe no need?
  return path.node.callee.type === 'MemberExpression' &&
    path.node.callee.object.type === 'Identifier' &&
    (path.node.callee.object.name === 'StyleSheet' || path.node.callee.object.name === 'MediaQueryStyleSheet') &&
    path.parent.type === 'VariableDeclarator'
}

const isStylesDotSomething = node => {
  return node.object.type === 'Identifier' &&
    (node.object.name === 'styles' || node.object.name === 'Styles') &&
    !node.computed &&
    node.property.type === 'Identifier'
}

const getName = idOrLiteral => {
  return idOrLiteral.type === 'Identifier'
    ? idOrLiteral.name
    : idOrLiteral.value
}

const locLines = (lines, loc) => lines.slice(loc.start.line - 1, loc.end.line).join('\n')

const append = (a, b) => [...a, ...b]

const parseSiblingFiles = (file) => {
  const filename = path.basename(file, ".js");
  const dirname = path.dirname(file);
  const files = glob.sync(dirname + "/!(" + filename + ").js");
  return files.map((siblingFile) => {
    const text = fs.readFileSync(siblingFile, 'utf8');
    const ast = parser.parse(text, {
      sourceType: 'module',
      plugins: ['jsx', 'flow', 'objectRestSpread', 'classProperties', 'dynamicImport'],
    })
    const lines = text.split('\n')
    const styleCalls = [];
    traverse(ast, {
      MemberExpression(path) {
        if (isStylesDotSomething(path.node)) {
          styleCalls.push({file: siblingFile, loc: path.node.loc, property: path.node.property.name})
        }
      },
    })
    return {styleCalls, lines, file: siblingFile};
  }).reduce((a, b) => {
    const files = a.files;
    files[b.file] = b.lines;
    return {styleCalls:[...a.styleCalls, ...b.styleCalls], files}
  }, {styleCalls:[], files:{}});
}

const getStyleSheets = (file, isGlobal) => {
  const text = fs.readFileSync(file, 'utf8')
  const ast = parser.parse(text, {
    sourceType: 'module',
    plugins: ['jsx', 'flow', 'objectRestSpread', 'classProperties', 'dynamicImport'],
  })
  const lines = text.split('\n')

  const styleSheets = []
  if (!isGlobal) {
    traverse(ast, {
      CallExpression(path) {
        if (isStyleSheetCreate(path)) {
          const members = path.node.arguments[0].properties.filter(
            property => property.type === 'ObjectProperty' // Not gonna try to figure out spreads
          )
          const keys = {}
          members.forEach(m => keys[getName(m.key)] = m)
          const keyNames = members.map(item => getName(item.key))
          styleSheets.push({id: path.parent.id, keys, keyNames})
        }
      },
    })
  } else {
    const keys = [];
    const keyNames = [];
    traverse(ast, {
      ObjectExpression(path) {
        if (!path.node.properties.find(n => n.type === 'ObjectProperty' && n.value.type === 'ObjectExpression')) {
          if (path.parent && path.parent.key) {
            keys[path.parent.key.name] = path.parent;
            keyNames.push(path.parent.key.name);
          } else if (path.parent && path.parent.id) {
            keys[path.parent.id.name] = path.parent;
            keyNames.push(path.parent.id.name);
          } else if (path.parent && path.parent.left){
            keys[path.parent.left.object.name] = path.parent.left;
            keyNames.push(path.parent.left.object.name);
          }
        }
      },
    })
    styleSheets.push({id: 'global', keys, keyNames});
  }
  return {styleSheets, lines}
}

module.exports = (file, globStyleFile) => {

  const { styleSheets, lines } = getStyleSheets(file);
  let globalKeyNames = [];
  if (globStyleFile) {
    const { styleSheets: globalStyleSheets } = getStyleSheets(globStyleFile, true);  
    globalKeyNames = globalStyleSheets[0].keyNames;
  }
  const siblingRefs = parseSiblingFiles(file);
  const refNames = siblingRefs.styleCalls.map(r => r.property);

  const sheets = styleSheets.map(({id, keys, keyNames}) => {

    const unused = keyNames.filter(k => refNames.indexOf(k) === -1).map(k => ({
      key: k,
      loc: keys[k].loc,
      code: locLines(lines, keys[k].loc),
    }))
    const missing = siblingRefs.styleCalls.filter(r => keyNames.indexOf(r.property) === -1 && globalKeyNames.indexOf(r.property) === -1).map(r => ({
      key: r.property,
      file: r.file,
      loc: r.loc,
      code: locLines(siblingRefs.files[r.file], r.loc),
    }))

    return {loc: id.loc, code: locLines(lines, id.loc), warnings:[], unused, missing}
  }).filter(x => x)
  return {sheets, lines}
}


