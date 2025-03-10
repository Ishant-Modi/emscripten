#!/usr/bin/env node

'use strict';

const acorn = require('acorn');
const terser = require('../third_party/terser/terser');
const fs = require('fs');

// Utilities

function print(x) {
  process.stdout.write(x + '\n');
}

function printErr(x) {
  process.stderr.write(x + '\n');
}

function read(x) {
  return fs.readFileSync(x).toString();
}

function assert(condition, text) {
  if (!condition) {
    throw new Error(text);
  }
}

function warnOnce(msg) {
  if (!warnOnce.msgs) warnOnce.msgs = {};
  if (msg in warnOnce.msgs) return;
  warnOnce.msgs[msg] = true;
  printErr('warning: ' + msg);
}

// Visits and walks
// (We don't use acorn-walk because it ignores x in 'x = y'.)

function visitChildren(node, c) {
  // emptyOut() and temporary ignoring may mark nodes as empty,
  // while they have properties with children we should ignore.
  if (node.type === 'EmptyStatement') {
    return;
  }
  function maybeChild(child) {
    if (child && typeof child === 'object' && typeof child.type === 'string') {
      c(child);
      return true;
    }
    return false;
  }
  for (const child of Object.values(node)) {
    // Check for a child.
    if (!maybeChild(child)) {
      // Check for an array of children.
      if (Array.isArray(child)) {
        child.forEach(maybeChild);
      }
    }
  }
}

// Simple post-order walk, calling properties on an object by node type,
// if the type exists.
function simpleWalk(node, cs) {
  visitChildren(node, function (child) {
    simpleWalk(child, cs);
  });
  if (node.type in cs) {
    cs[node.type](node);
  }
}

// Full post-order walk, calling a single function for all types.
function fullWalk(node, c) {
  visitChildren(node, function (child) {
    fullWalk(child, c);
  });
  c(node);
}

// Recursive post-order walk, calling properties on an object by node type,
// if the type exists, and if so leaving recursion to that function.
function recursiveWalk(node, cs) {
  (function c(node) {
    if (!(node.type in cs)) {
      visitChildren(node, function (child) {
        recursiveWalk(child, cs);
      });
    } else {
      cs[node.type](node, c);
    }
  })(node);
}

// AST Utilities

function emptyOut(node) {
  node.type = 'EmptyStatement';
}

function nullify(node) {
  node.type = 'Literal';
  node.value = null;
  node.raw = 'null';
}

// This converts the node into something that terser will ignore in a var
// declaration, that is, it is a way to get rid of initial values.
function convertToNothingInVarInit(node) {
  node.type = 'Literal';
  node.value = undefined;
  node.raw = 'undefined';
}

function convertToNull(node) {
  node.type = 'Identifier';
  node.name = 'null';
}

function convertToNullStatement(node) {
  node.type = 'ExpressionStatement';
  node.expression = {
    type: 'Literal',
    value: null,
    raw: 'null',
    start: 0,
    end: 0,
  };
  node.start = 0;
  node.end = 0;
}

function isNull(node) {
  return node.type === 'Literal' && node.raw === 'null';
}

function isUseStrict(node) {
  return node.type === 'Literal' && node.value === 'use strict';
}

function setLiteralValue(item, value) {
  item.value = value;
  item.raw = "'" + value + "'";
}

function isLiteralString(node) {
  return node.type === 'Literal' && (node.raw[0] === '"' || node.raw[0] === "'");
}

function dump(node, text) {
  if (text) print(text);
  print(JSON.stringify(node, null, ' '));
}

// Mark inner scopes temporarily as empty statements. Returns
// a special object that must be used to restore them.
function ignoreInnerScopes(node) {
  const map = new WeakMap();
  function ignore(node) {
    map.set(node, node.type);
    node.type = 'EmptyStatement';
  }
  simpleWalk(node, {
    FunctionDeclaration(node) {
      ignore(node);
    },
    FunctionExpression(node) {
      ignore(node);
    },
    ArrowFunctionExpression(node) {
      ignore(node);
    },
    // TODO: arrow etc.
  });
  return map;
}

// Mark inner scopes temporarily as empty statements.
function restoreInnerScopes(node, map) {
  fullWalk(node, function (node) {
    if (map.has(node)) {
      node.type = map.get(node);
      map.delete(node);
      restoreInnerScopes(node, map);
    }
  });
}

// If we empty out a var from
//   for (var i in x) {}
//   for (var j = 0;;) {}
// then it will be invalid. We saved it on the side;
// restore it here.
function restoreForVars(node) {
  let restored = 0;
  function fix(init) {
    if (init && init.type === 'EmptyStatement') {
      assert(init.oldDeclarations);
      init.type = 'VariableDeclaration';
      init.declarations = init.oldDeclarations;
      restored++;
    }
  }
  simpleWalk(node, {
    ForStatement(node) {
      fix(node.init);
    },
    ForInStatement(node) {
      fix(node.left);
    },
    ForOfStatement(node) {
      fix(node.left);
    },
  });
  return restored;
}

function hasSideEffects(node) {
  // Conservative analysis.
  const map = ignoreInnerScopes(node);
  let has = false;
  fullWalk(node, function (node) {
    switch (node.type) {
      // TODO: go through all the ESTree spec
      case 'Literal':
      case 'Identifier':
      case 'UnaryExpression':
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'ExpressionStatement':
      case 'UpdateOperator':
      case 'ConditionalExpression':
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'VariableDeclaration':
      case 'VariableDeclarator':
      case 'ObjectExpression':
      case 'Property':
      case 'SpreadElement':
      case 'BlockStatement':
      case 'ArrayExpression':
      case 'EmptyStatement': {
        break; // safe
      }
      case 'MemberExpression': {
        // safe if on Math (or other familiar objects, TODO)
        if (node.object.type !== 'Identifier' || node.object.name !== 'Math') {
          // console.error('because member on ' + node.object.name);
          has = true;
        }
        break;
      }
      case 'NewExpression': {
        // default to unsafe, but can be safe on some familiar objects
        if (node.callee.type === 'Identifier') {
          const name = node.callee.name;
          if (
            name === 'TextDecoder' ||
            name === 'ArrayBuffer' ||
            name === 'Int8Array' ||
            name === 'Uint8Array' ||
            name === 'Int16Array' ||
            name === 'Uint16Array' ||
            name === 'Int32Array' ||
            name === 'Uint32Array' ||
            name === 'Float32Array' ||
            name === 'Float64Array'
          ) {
            // no side effects, but the arguments might (we walk them in
            // full walk as well)
            break;
          }
        }
        // not one of the safe cases
        has = true;
        break;
      }
      default: {
        has = true;
      }
    }
  });
  restoreInnerScopes(node, map);
  return has;
}

// Passes

// Removes obviously-unused code. Similar to closure compiler in its rules -
// export e.g. by Module['..'] = theThing; , or use it somewhere, otherwise
// it goes away.
//
// Note that this is somewhat conservative, since the ESTree AST does not
// have a simple separation between definitions and uses, e.g.
// Identifier is used both for the x in  function foo(x) {
// and for  y = x + 1 . That means we need to consider new ES6+ constructs
// as they appear (like ArrowFunctionExpression). Instead, we do a conservative
// analysis here.

function runJSDCE(ast, aggressive) {
  function iteration() {
    let removed = 0;
    const scopes = [{}]; // begin with empty toplevel scope
    function DUMP() {
      printErr('vvvvvvvvvvvvvv');
      for (let i = 0; i < scopes.length; i++) {
        printErr(i + ' : ' + JSON.stringify(scopes[i]));
      }
      printErr('^^^^^^^^^^^^^^');
    }
    function ensureData(scope, name) {
      if (Object.prototype.hasOwnProperty.call(scope, name)) return scope[name];
      scope[name] = {
        def: 0,
        use: 0,
        param: 0, // true for function params, which cannot be eliminated
      };
      return scope[name];
    }
    function cleanUp(ast, names) {
      recursiveWalk(ast, {
        VariableDeclaration(node, c) {
          const old = node.declarations;
          let removedHere = 0;
          node.declarations = node.declarations.filter(function (node) {
            const curr = node.id.name;
            const value = node.init;
            const keep = !(curr in names) || (value && hasSideEffects(value));
            if (!keep) removedHere = 1;
            return keep;
          });
          removed += removedHere;
          if (node.declarations.length === 0) {
            emptyOut(node);
            // If this is in a for, we may need to restore it.
            node.oldDeclarations = old;
          }
        },
        ExpressionStatement(node, c) {
          if (aggressive && !hasSideEffects(node)) {
            if (!isNull(node.expression) && !isUseStrict(node.expression)) {
              convertToNullStatement(node);
              removed++;
            }
          }
        },
        FunctionDeclaration(node, c) {
          if (Object.prototype.hasOwnProperty.call(names, node.id.name)) {
            removed++;
            emptyOut(node);
            return;
          }
          // do not recurse into other scopes
        },
        // do not recurse into other scopes
        FunctionExpression() {},
        ArrowFunctionExpression() {},
      });
      removed -= restoreForVars(ast);
    }

    function handleFunction(node, c, defun) {
      // defun names matter - function names (the y in var x = function y() {..}) are just for stack traces.
      if (defun) {
        ensureData(scopes[scopes.length - 1], node.id.name).def = 1;
      }
      const scope = {};
      node.params.forEach(function (param) {
        const name = param.name;
        ensureData(scope, name).def = 1;
        scope[name].param = 1;
      });
      scopes.push(scope);
      c(node.body);
      // we can ignore self-references, i.e., references to ourselves inside
      // ourselves, for named defined (defun) functions
      const ownName = defun ? node.id.name : '';
      const names = {};
      for (const name in scopes.pop()) {
        if (name === ownName) continue;
        const data = scope[name];
        if (data.use && !data.def) {
          // this is used from a higher scope, propagate the use down
          ensureData(scopes[scopes.length - 1], name).use = 1;
          continue;
        }
        if (data.def && !data.use && !data.param) {
          // this is eliminateable!
          names[name] = 0;
        }
      }
      cleanUp(node.body, names);
    }

    recursiveWalk(ast, {
      VariableDeclarator(node, c) {
        const name = node.id.name;
        ensureData(scopes[scopes.length - 1], name).def = 1;
        if (node.init) c(node.init);
      },
      ObjectExpression(node, c) {
        // ignore the property identifiers
        node.properties.forEach(function (node) {
          if (node.value) {
            c(node.value);
          } else if (node.argument) {
            c(node.argument);
          }
        });
      },
      MemberExpression(node, c) {
        c(node.object);
        // Ignore a property identifier (a.X), but notice a[X] (computed
        // is true) and a["X"] (it will be a Literal and not Identifier).
        if (node.property.type !== 'Identifier' || node.computed) {
          c(node.property);
        }
      },
      FunctionDeclaration(node, c) {
        handleFunction(node, c, true /* defun */);
      },
      FunctionExpression(node, c) {
        handleFunction(node, c);
      },
      ArrowFunctionExpression(node, c) {
        handleFunction(node, c);
      },
      Identifier(node, c) {
        const name = node.name;
        ensureData(scopes[scopes.length - 1], name).use = 1;
      },
    });

    // toplevel
    const scope = scopes.pop();
    assert(scopes.length === 0);

    const names = {};
    for (const [name, data] of Object.entries(scope)) {
      if (data.def && !data.use) {
        assert(!data.param); // can't be
        // this is eliminateable!
        names[name] = 0;
      }
    }
    cleanUp(ast, names);
    return removed;
  }
  while (iteration() && aggressive) {}
}

// Aggressive JSDCE - multiple iterations
function runAJSDCE(ast) {
  runJSDCE(ast, /* aggressive= */ true);
}

function isWasmImportsAssign(node) {
  // var wasmImports = ..
  return (
    node.type === 'VariableDeclaration' &&
    node.declarations.length === 1 &&
    node.declarations[0].id.name === 'wasmImports' &&
    node.declarations[0].init &&
    node.declarations[0].init.type === 'ObjectExpression'
  );
}

function getWasmImportsValue(node) {
  return node.declarations[0].init;
}

function isAsmUse(node) {
  return (
    node.type === 'MemberExpression' &&
    ((node.object.type === 'Identifier' && // asm['X']
      node.object.name === 'asm' &&
      node.property.type === 'Literal') ||
      (node.object.type === 'MemberExpression' && // Module['asm']['X']
        node.object.object.type === 'Identifier' &&
        node.object.object.name === 'Module' &&
        node.object.property.type === 'Literal' &&
        node.object.property.value === 'asm' &&
        isLiteralString(node.property)))
  );
}

function getAsmOrModuleUseName(node) {
  return node.property.value;
}

function isModuleUse(node) {
  return (
    node.type === 'MemberExpression' && // Module['X']
    node.object.type === 'Identifier' &&
    node.object.name === 'Module' &&
    isLiteralString(node.property)
  );
}

function isModuleAsmUse(node) {
  // Module['asm'][..string..]
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'MemberExpression' &&
    node.object.object.type === 'Identifier' &&
    node.object.object.name === 'Module' &&
    node.object.property.type === 'Literal' &&
    node.object.property.value === 'asm' &&
    isLiteralString(node.property)
  );
}

// Apply import/export name changes (after minifying them)
function applyImportAndExportNameChanges(ast) {
  const mapping = extraInfo.mapping;
  fullWalk(ast, function (node) {
    if (isWasmImportsAssign(node)) {
      const assignedObject = getWasmImportsValue(node);
      assignedObject.properties.forEach(function (item) {
        if (mapping[item.key.value]) {
          setLiteralValue(item.key, mapping[item.key.value]);
        }
      });
    } else if (node.type === 'AssignmentExpression') {
      const target = node.left;
      const value = node.right;
      if (isAsmUse(value)) {
        const name = value.property.value;
        if (mapping[name]) {
          setLiteralValue(value.property, mapping[name]);
        }
      }
    } else if (node.type === 'CallExpression' && isAsmUse(node.callee)) {
      // asm["___wasm_call_ctors"](); -> asm["M"]();
      const callee = node.callee;
      const name = callee.property.value;
      if (mapping[name]) {
        setLiteralValue(callee.property, mapping[name]);
      }
    } else if (isModuleAsmUse(node)) {
      const prop = node.property;
      const name = prop.value;
      if (mapping[name]) {
        setLiteralValue(prop, mapping[name]);
      }
    } else if (isAsmUse(node)) {
      const prop = node.property;
      const name = prop.value;
      if (mapping[name]) {
        setLiteralValue(prop, mapping[name]);
      }
    }
  });
}

// A static dyncall is dynCall('vii', ..), which is actually static even
// though we call dynCall() - we see the string signature statically.
function isStaticDynCall(node) {
  return (
    node.type === 'CallExpression' &&
    node.callee.type === 'Identifier' &&
    node.callee.name === 'dynCall' &&
    isLiteralString(node.arguments[0])
  );
}

function getStaticDynCallName(node) {
  return 'dynCall_' + node.arguments[0].value;
}

// a dynamic dyncall is one in which all we know is *some* dynCall may
// be called, but not who. This can be either
//   dynCall(*not a string*, ..)
// or, to be conservative,
//   "dynCall_"
// as that prefix means we may be constructing a dynamic dyncall name
// (dynCall and embind's requireFunction do this internally).
function isDynamicDynCall(node) {
  return (
    (node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'dynCall' &&
      !isLiteralString(node.arguments[0])) ||
    (isLiteralString(node) && node.value === 'dynCall_')
  );
}

//
// Matches the wasm export wrappers generated by emcc (see make_export_wrappers
// in emscripten.py). For example:
//
//   var _foo = function() {
//     return (_foo = Module['asm']['foo']).apply(null, argument)
//   }
//
function isExportWrapperFunction(f) {
  if (f.body.type != 'BlockStatement') return null;
  if (f.body.body.length != 1) return null;
  const expr = f.body.body[0];
  if (expr.type == 'ReturnStatement') {
    const rtn = expr.argument;
    // We are looking for a call of special target, like (x = y)(), and not a
    // non-call or a normal direct call such as z().
    if (rtn.type == 'CallExpression' && rtn.callee.object) {
      let target = rtn.callee.object;
      if (target.type == 'ParenthesizedExpression') {
        target = target.expression;
      }
      if (target.type == 'AssignmentExpression') {
        const rhs = target.right;
        if (isAsmUse(rhs)) {
          return getAsmOrModuleUseName(rhs);
        }
      }
    }
  }
  return null;
}

//
// Emit the DCE graph, to help optimize the combined JS+wasm.
// This finds where JS depends on wasm, and where wasm depends
// on JS, and prints that out.
//
// The analysis here is simplified, and not completely general. It
// is enough to optimize the common case of JS library and runtime
// functions involved in loops with wasm, but not more complicated
// things like JS objects and sub-functions. Specifically we
// analyze as follows:
//
//  * We consider (1) the toplevel scope, and (2) the scopes of toplevel defined
//    functions (defun, not function; i.e., function X() {} where
//    X can be called later, and not y = function Z() {} where Z is
//    just a name for stack traces). We also consider the wasm, which
//    we can see things going to and arriving from.
//  * Anything used in a defun creates a link in the DCE graph, either
//    to another defun, or the wasm.
//  * Anything used in the toplevel scope is rooted, as it is code
//    we assume will execute. The exceptions are
//     * when we receive something from wasm; those are "free" and
//       do not cause rooting. (They will become roots if they are
//       exported, the metadce logic will handle that.)
//     * when we send something to wasm; sending a defun causes a
//       link in the DCE graph.
//  * Anything not in the toplevel or not in a toplevel defun is
//    considering rooted. We don't optimize those cases.
//
// Special handling:
//
//  * dynCall('vii', ..) are dynamic dynCalls, but we analyze them
//    statically, to preserve the dynCall_vii etc. method they depend on.
//    Truly dynamic dynCalls (not to a string constant) will not work,
//    and require the user to export them.
//  * Truly dynamic dynCalls are assumed to reach any dynCall_*.
//
// XXX this modifies the input AST. if you want to keep using it,
//     that should be fixed. Currently the main use case here does
//     not require that. TODO FIXME
//
function emitDCEGraph(ast) {
  // First pass: find the wasm imports and exports, and the toplevel
  // defuns, and save them on the side, removing them from the AST,
  // which makes the second pass simpler.
  //
  // The imports that wasm receives look like this:
  //
  //  var wasmImports = { "abort": abort, "assert": assert, [..] };
  //
  // The exports are trickier, as they have a different form whether or not
  // async compilation is enabled. It can be either:
  //
  //  var _malloc = Module["_malloc"] = asm["_malloc"];
  //
  // or
  //
  //  var _malloc = asm["_malloc"];
  //
  // or
  //
  //  var _malloc = Module["_malloc"] = (function() {
  //   return Module["asm"]["_malloc"].apply(null, arguments);
  //  });
  //
  // or, in the minimal runtime, it looks like
  //
  //  WebAssembly.instantiate(Module["wasm"], imports).then(function(output) {
  //   var asm = output.instance.exports; // may also not have "var", if
  //                                      // declared outside and used elsewhere
  //   ..
  //   _malloc = asm["malloc"];
  //   ..
  //  });
  const imports = [];
  const defuns = [];
  const dynCallNames = [];
  const nameToGraphName = {};
  const modulePropertyToGraphName = {};
  const exportNameToGraphName = {}; // identical to asm['..'] nameToGraphName
  const graph = [];
  let foundWasmImportsAssign = false;
  let foundMinimalRuntimeExports = false;

  function saveAsmExport(name, asmName) {
    // the asmName is what the wasm provides directly; the outside JS
    // name may be slightly different (extra "_" in wasm backend)
    const graphName = getGraphName(name, 'export');
    nameToGraphName[name] = graphName;
    modulePropertyToGraphName[name] = graphName;
    exportNameToGraphName[asmName] = graphName;
    if (/^dynCall_/.test(name)) {
      dynCallNames.push(graphName);
    }
  }

  fullWalk(ast, function (node) {
    if (isWasmImportsAssign(node)) {
      const assignedObject = getWasmImportsValue(node);
      assignedObject.properties.forEach(function (item) {
        let value = item.value;
        if (value.type === 'Literal' || value.type === 'FunctionExpression') {
          return; // if it's a numeric or function literal, nothing to do here
        }
        if (value.type === 'LogicalExpression') {
          // We may have something like  wasmMemory || Module.wasmMemory  in pthreads code;
          // use the left hand identifier.
          value = value.left;
        }
        assert(value.type === 'Identifier');
        imports.push(value.name); // the name doesn't matter, only the value which is that actual thing we are importing
      });
      foundWasmImportsAssign = true;
      emptyOut(node); // ignore this in the second pass; this does not root
    } else if (node.type === 'VariableDeclaration') {
      if (node.declarations.length === 1) {
        const item = node.declarations[0];
        const name = item.id.name;
        const value = item.init;
        if (value && isAsmUse(value)) {
          const asmName = getAsmOrModuleUseName(value);
          // this is
          //  var _x = asm['x'];
          saveAsmExport(name, asmName);
          emptyOut(node);
        } else if (value && value.type === 'FunctionExpression') {
          // this is
          //  var x = function() { return (x = Module['asm']['x']).apply .. }
          let asmName = isExportWrapperFunction(value);
          if (asmName) {
            saveAsmExport(name, asmName);
            emptyOut(node);
          }
        } else if (value && value.type === 'AssignmentExpression') {
          const assigned = value.left;
          if (isModuleUse(assigned) && getAsmOrModuleUseName(assigned) === name) {
            // this is
            //  var x = Module['x'] = ?
            // which looks like a wasm export being received. confirm with the asm use
            let found = 0;
            let asmName;
            fullWalk(value.right, function (node) {
              if (isAsmUse(node)) {
                found++;
                asmName = getAsmOrModuleUseName(node);
              }
            });
            // in the wasm backend, the asm name may have one fewer "_" prefixed
            if (found === 1) {
              // this is indeed an export
              // the asmName is what the wasm provides directly; the outside JS
              // name may be slightly different (extra "_" in wasm backend)
              saveAsmExport(name, asmName);
              emptyOut(node); // ignore this in the second pass; this does not root
              return;
            }
            if (value.right.type === 'Literal') {
              // this is
              //  var x = Module['x'] = 1234;
              // this form occurs when global addresses are exported from the
              // module.  It doesn't constitute a usage.
              assert(typeof value.right.value === 'number');
              emptyOut(node);
            }
          }
        }
      }
      // A variable declaration that has no initial values can be ignored in
      // the second pass, these are just declarations, not roots - an actual
      // use must be found in order to root.
      if (!node.declarations.reduce((hasInit, decl) => hasInit || !!decl.init, false)) {
        emptyOut(node);
      }
    } else if (node.type === 'FunctionDeclaration') {
      defuns.push(node);
      const name = node.id.name;
      nameToGraphName[name] = getGraphName(name, 'defun');
      emptyOut(node); // ignore this in the second pass; we scan defuns separately
    } else if (node.type === 'FunctionExpression') {
      // Check if this is the minimal runtime exports function, which looks like
      //   (output) => { var asm = output.instance.exports;
      if (
        node.params.length === 1 &&
        node.params[0].type === 'Identifier' &&
        node.params[0].name === 'output' &&
        node.body.type === 'BlockStatement'
      ) {
        const body = node.body.body;
        if (body.length >= 1) {
          const first = body[0];
          let target;
          let value; // "(var?) target = value"
          // Look either for  var asm =  or just   asm =
          if (first.type === 'VariableDeclaration' && first.declarations.length === 1) {
            const decl = first.declarations[0];
            target = decl.id;
            value = decl.init;
          } else if (
            first.type === 'ExpressionStatement' &&
            first.expression.type === 'AssignmentExpression'
          ) {
            const assign = first.expression;
            if (assign.operator === '=') {
              target = assign.left;
              value = assign.right;
            }
          }
          if (target && target.type === 'Identifier' && target.name === 'asm' && value) {
            if (
              value.type === 'MemberExpression' &&
              value.object.type === 'MemberExpression' &&
              value.object.object.type === 'Identifier' &&
              value.object.object.name === 'output' &&
              value.object.property.type === 'Identifier' &&
              value.object.property.name === 'instance' &&
              value.property.type === 'Identifier' &&
              value.property.name === 'exports'
            ) {
              // This looks very much like what we are looking for.
              assert(!foundMinimalRuntimeExports);
              for (let i = 1; i < body.length; i++) {
                const item = body[i];
                if (
                  item.type === 'ExpressionStatement' &&
                  item.expression.type === 'AssignmentExpression' &&
                  item.expression.operator === '=' &&
                  item.expression.left.type === 'Identifier' &&
                  item.expression.right.type === 'MemberExpression' &&
                  item.expression.right.object.type === 'Identifier' &&
                  item.expression.right.object.name === 'asm' &&
                  item.expression.right.property.type === 'Literal'
                ) {
                  const name = item.expression.left.name;
                  const asmName = item.expression.right.property.value;
                  saveAsmExport(name, asmName);
                  emptyOut(item); // ignore all this in the second pass; this does not root
                }
              }
              foundMinimalRuntimeExports = true;
            }
          }
        }
      }
    }
  });
  // must find the info we need
  assert(
    foundWasmImportsAssign,
    'could not find the assigment to "wasmImports". perhaps --pre-js or --post-js code moved it out of the global scope? (things like that should be done after emcc runs, as they do not need to be run through the optimizer which is the special thing about --pre-js/--post-js code)'
  );
  // Read exports that were declared in extraInfo
  if (extraInfo) {
    for (const exp of extraInfo.exports) {
      saveAsmExport(exp[0], exp[1]);
    }
  }
  // Second pass: everything used in the toplevel scope is rooted;
  // things used in defun scopes create links
  function getGraphName(name, what) {
    return 'emcc$' + what + '$' + name;
  }
  const infos = {}; // the graph name of the item => info for it
  for (const import_ of imports) {
    const name = getGraphName(import_, 'import');
    const info = (infos[name] = {
      name: name,
      import: ['env', import_],
      reaches: {},
    });
    if (nameToGraphName.hasOwnProperty(import_)) {
      info.reaches[nameToGraphName[import_]] = 1;
    } // otherwise, it's a number, ignore
  }
  for (const [e, name] of Object.entries(exportNameToGraphName)) {
    const name = exportNameToGraphName[e];
    infos[name] = {
      name: name,
      export: e,
      reaches: {},
    };
  }
  // a function that handles a node we visit, in either a defun or
  // the toplevel scope (in which case the second param is not provided)
  function visitNode(node, defunInfo) {
    // TODO: scope awareness here. for now we just assume all uses are
    //       from the top scope, which might create more uses than needed
    let reached;
    if (node.type === 'Identifier') {
      const name = node.name;
      if (nameToGraphName.hasOwnProperty(name)) {
        reached = nameToGraphName[name];
      }
    } else if (isModuleUse(node)) {
      const name = getAsmOrModuleUseName(node);
      if (modulePropertyToGraphName.hasOwnProperty(name)) {
        reached = modulePropertyToGraphName[name];
      }
    } else if (isStaticDynCall(node)) {
      reached = getGraphName(getStaticDynCallName(node), 'export');
    } else if (isDynamicDynCall(node)) {
      // this can reach *all* dynCall_* targets, we can't narrow it down
      reached = dynCallNames;
    } else if (isAsmUse(node)) {
      // any remaining asm uses are always rooted in any case
      const name = getAsmOrModuleUseName(node);
      if (exportNameToGraphName.hasOwnProperty(name)) {
        infos[exportNameToGraphName[name]].root = true;
      }
      return;
    }
    if (reached) {
      function addReach(reached) {
        if (defunInfo) {
          defunInfo.reaches[reached] = 1; // defun reaches it
        } else {
          if (infos[reached]) {
            infos[reached].root = true; // in global scope, root it
          } else {
            // An info might not exist for the identifer if it is missing, for
            // example, we might call Module.dynCall_vi in library code, but it
            // won't exist in a standalone (non-JS) build anyhow. We can ignore
            // it in that case as the JS won't be used, but warn to be safe.
            if (verbose) {
              console.warn('metadce: missing declaration for ' + reached);
            }
          }
        }
      }
      if (typeof reached === 'string') {
        addReach(reached);
      } else {
        reached.forEach(addReach);
      }
    }
  }
  defuns.forEach(defun => {
    const name = getGraphName(defun.id.name, 'defun');
    const info = (infos[name] = {
      name: name,
      reaches: {},
    });
    fullWalk(defun.body, node => visitNode(node, info));
  });
  fullWalk(ast, node => visitNode(node, null));
  // Final work: print out the graph
  // sort for determinism
  function sortedNamesFromMap(map) {
    const names = [];
    for (const name of Object.keys(map)) {
      names.push(name);
    }
    names.sort();
    return names;
  }
  sortedNamesFromMap(infos).forEach(name => {
    const info = infos[name];
    info.reaches = sortedNamesFromMap(info.reaches);
    graph.push(info);
  });
  print(JSON.stringify(graph, null, ' '));
}

// Apply graph removals from running wasm-metadce
function applyDCEGraphRemovals(ast) {
  const unused = new Set(extraInfo.unused);

  fullWalk(ast, node => {
    if (isWasmImportsAssign(node)) {
      const assignedObject = getWasmImportsValue(node);
      assignedObject.properties = assignedObject.properties.filter(item => {
        const name = item.key.value;
        const value = item.value;
        const full = 'emcc$import$' + name;
        return !(unused.has(full) && !hasSideEffects(value));
      });
    } else if (node.type === 'AssignmentExpression') {
      // when we assign to a thing we don't need, we can just remove the assign
      //   var x = Module['x'] = asm['x'];
      const target = node.left;
      if (isAsmUse(target) || isModuleUse(target)) {
        const name = getAsmOrModuleUseName(target);
        const full = 'emcc$export$' + name;
        const value = node.right;
        if (unused.has(full) && (isAsmUse(value) || !hasSideEffects(value))) {
          // This will be in a var init, and we just remove that value.
          convertToNothingInVarInit(node);
        }
      }
    } else if (node.type === 'VariableDeclaration') {
      // Handle the case we declare a variable but don't assign to the module:
      //   var x = asm['x'];
      // and
      //   var x = function() { return (x = asm['x']).apply(...) };
      const init = node.declarations[0].init;
      if (init) {
        if (isAsmUse(init)) {
          const name = getAsmOrModuleUseName(init);
          const full = 'emcc$export$' + name;
          if (unused.has(full)) {
            convertToNothingInVarInit(init);
          }
        } else if (init.type == 'FunctionExpression') {
          const name = isExportWrapperFunction(init);
          const full = 'emcc$export$' + name;
          if (unused.has(full)) {
            convertToNothingInVarInit(init);
          }
        }
      }
    } else if (node.type === 'ExpressionStatement') {
      const expr = node.expression;
      // In the minimal runtime code pattern we have just
      //   x = asm['x']
      // and never in a var.
      if (expr.operator === '=' && expr.left.type === 'Identifier' && isAsmUse(expr.right)) {
        const name = expr.left.name;
        if (name === getAsmOrModuleUseName(expr.right)) {
          const full = 'emcc$export$' + name;
          if (unused.has(full)) {
            emptyOut(node);
          }
        }
      }
    }
  });
}

// Need a parser to pass to acorn.Node constructor.
// Create it once and reuse it.
const stubParser = new acorn.Parser({ecmaVersion: 2020});

function createNode(props) {
  const node = new acorn.Node(stubParser);
  Object.assign(node, props);
  return node;
}

function createLiteral(value) {
  return createNode({
    type: 'Literal',
    value: value,
    raw: '' + value,
  });
}

function makeCallExpression(node, name, args) {
  Object.assign(node, {
    type: 'CallExpression',
    callee: createNode({
      type: 'Identifier',
      name: name,
    }),
    arguments: args,
  });
}

function isEmscriptenHEAP(name) {
  switch (name) {
    case 'HEAP8':
    case 'HEAPU8':
    case 'HEAP16':
    case 'HEAPU16':
    case 'HEAP32':
    case 'HEAPU32':
    case 'HEAPF32':
    case 'HEAPF64': {
      return true;
    }
    default: {
      return false;
    }
  }
}

// Replaces each HEAP access with function call that uses DataView to enforce
// LE byte order for HEAP buffer
function littleEndianHeap(ast) {
  recursiveWalk(ast, {
    FunctionDeclaration: (node, c) => {
      // do not recurse into LE_HEAP_STORE, LE_HEAP_LOAD functions
      if (!(node.id.type === 'Identifier' && node.id.name.startsWith('LE_HEAP'))) {
        c(node.body);
      }
    },
    AssignmentExpression: (node, c) => {
      const target = node.left;
      const value = node.right;
      c(value);
      if (!isHEAPAccess(target)) {
        // not accessing the HEAP
        c(target);
      } else {
        // replace the heap access with LE_HEAP_STORE
        const name = target.object.name;
        const idx = target.property;
        switch (target.object.name) {
          case 'HEAP8':
          case 'HEAPU8': {
            // no action required - storing only 1 byte
            break;
          }
          case 'HEAP16': {
            // change "name[idx] = value" to "LE_HEAP_STORE_I16(idx*2, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_I16', [multiply(idx, 2), value]);
            break;
          }
          case 'HEAPU16': {
            // change "name[idx] = value" to "LE_HEAP_STORE_U16(idx*2, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_U16', [multiply(idx, 2), value]);
            break;
          }
          case 'HEAP32': {
            // change "name[idx] = value" to "LE_HEAP_STORE_I32(idx*4, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_I32', [multiply(idx, 4), value]);
            break;
          }
          case 'HEAPU32': {
            // change "name[idx] = value" to "LE_HEAP_STORE_U32(idx*4, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_U32', [multiply(idx, 4), value]);
            break;
          }
          case 'HEAPF32': {
            // change "name[idx] = value" to "LE_HEAP_STORE_F32(idx*4, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_F32', [multiply(idx, 4), value]);
            break;
          }
          case 'HEAPF64': {
            // change "name[idx] = value" to "LE_HEAP_STORE_F64(idx*8, value)"
            makeCallExpression(node, 'LE_HEAP_STORE_F64', [multiply(idx, 8), value]);
            break;
          }
        }
      }
    },
    MemberExpression: (node, c) => {
      c(node.property);
      if (!isHEAPAccess(node)) {
        // not accessing the HEAP
        c(node.object);
      } else {
        // replace the heap access with LE_HEAP_LOAD
        const idx = node.property;
        switch (node.object.name) {
          case 'HEAP8':
          case 'HEAPU8': {
            // no action required - loading only 1 byte
            break;
          }
          case 'HEAP16': {
            // change "name[idx]" to "LE_HEAP_LOAD_I16(idx*2)"
            makeCallExpression(node, 'LE_HEAP_LOAD_I16', [multiply(idx, 2)]);
            break;
          }
          case 'HEAPU16': {
            // change "name[idx]" to "LE_HEAP_LOAD_U16(idx*2)"
            makeCallExpression(node, 'LE_HEAP_LOAD_U16', [multiply(idx, 2)]);
            break;
          }
          case 'HEAP32': {
            // change "name[idx]" to "LE_HEAP_LOAD_I32(idx*4)"
            makeCallExpression(node, 'LE_HEAP_LOAD_I32', [multiply(idx, 4)]);
            break;
          }
          case 'HEAPU32': {
            // change "name[idx]" to "LE_HEAP_LOAD_U32(idx*4)"
            makeCallExpression(node, 'LE_HEAP_LOAD_U32', [multiply(idx, 4)]);
            break;
          }
          case 'HEAPF32': {
            // change "name[idx]" to "LE_HEAP_LOAD_F32(idx*4)"
            makeCallExpression(node, 'LE_HEAP_LOAD_F32', [multiply(idx, 4)]);
            break;
          }
          case 'HEAPF64': {
            // change "name[idx]" to "LE_HEAP_LOAD_F64(idx*8)"
            makeCallExpression(node, 'LE_HEAP_LOAD_F64', [multiply(idx, 8)]);
            break;
          }
        }
      }
    },
  });
}

// Instrument heap accesses to call GROWABLE_HEAP_* helper functions instead, which allows
// pthreads + memory growth to work (we check if the memory was grown on another thread
// in each access), see #8365.
function growableHeap(ast) {
  recursiveWalk(ast, {
    AssignmentExpression: node => {
      if (node.left.type === 'Identifier' && isEmscriptenHEAP(node.left.name)) {
        // Don't transform initial setup of the arrays.
        return;
      }
      growableHeap(node.left);
      growableHeap(node.right);
    },
    VariableDeclaration: node => {
      // Don't transform the var declarations for HEAP8 etc
      node.declarations.forEach(function (decl) {
        // but do transform anything that sets a var to
        // something from HEAP8 etc
        if (decl.init) {
          growableHeap(decl.init);
        }
      });
    },
    Identifier: node => {
      if (node.name.startsWith('HEAP')) {
        // Turn HEAP8 into GROWABLE_HEAP_I8() etc
        switch (node.name) {
          case 'HEAP8': {
            makeCallExpression(node, 'GROWABLE_HEAP_I8', []);
            break;
          }
          case 'HEAPU8': {
            makeCallExpression(node, 'GROWABLE_HEAP_U8', []);
            break;
          }
          case 'HEAP16': {
            makeCallExpression(node, 'GROWABLE_HEAP_I16', []);
            break;
          }
          case 'HEAPU16': {
            makeCallExpression(node, 'GROWABLE_HEAP_U16', []);
            break;
          }
          case 'HEAP32': {
            makeCallExpression(node, 'GROWABLE_HEAP_I32', []);
            break;
          }
          case 'HEAPU32': {
            makeCallExpression(node, 'GROWABLE_HEAP_U32', []);
            break;
          }
          case 'HEAPF32': {
            makeCallExpression(node, 'GROWABLE_HEAP_F32', []);
            break;
          }
          case 'HEAPF64': {
            makeCallExpression(node, 'GROWABLE_HEAP_F64', []);
            break;
          }
          default: {
          }
        }
      }
    },
  });
}

// Make all JS pointers unsigned. We do this by modifying things like
// HEAP32[X >> 2] to HEAP32[X >>> 2]. We also need to handle the case of
// HEAP32[X] and make that HEAP32[X >>> 0], things like subarray(), etc.
function unsignPointers(ast) {
  // Aside from the standard emscripten HEAP*s, also identify just "HEAP"/"heap"
  // as representing a heap. This can be used in JS library code in order
  // to get this pass to fix it up.
  function isHeap(name) {
    return isEmscriptenHEAP(name) || name === 'heap' || name === 'HEAP';
  }

  function unsign(node) {
    // The pointer is often a >> shift, which we can just turn into >>>
    if (node.type === 'BinaryExpression') {
      if (node.operator === '>>') {
        node.operator = '>>>';
        return node;
      }
    }
    // If nothing else worked out, add a new shift.
    return {
      type: 'BinaryExpression',
      left: node,
      operator: '>>>',
      right: {
        type: 'Literal',
        value: 0,
        raw: '0',
        start: 0,
        end: 0,
      },
      start: 0,
      end: 0,
    };
  }

  fullWalk(ast, function (node) {
    if (node.type === 'MemberExpression') {
      // Check if this is HEAP*[?]
      if (node.object.type === 'Identifier' && isHeap(node.object.name) && node.computed) {
        node.property = unsign(node.property);
      }
    } else if (node.type === 'CallExpression') {
      if (
        node.callee.type === 'MemberExpression' &&
        node.callee.object.type === 'Identifier' &&
        isHeap(node.callee.object.name) &&
        node.callee.property.type === 'Identifier' &&
        !node.computed
      ) {
        // This is a call on HEAP*.?. Specific things we need to fix up are
        // subarray, set, and copyWithin. TODO more?
        if (node.callee.property.name === 'set') {
          if (node.arguments.length >= 2) {
            node.arguments[1] = unsign(node.arguments[1]);
          }
        } else if (node.callee.property.name === 'subarray') {
          if (node.arguments.length >= 1) {
            node.arguments[0] = unsign(node.arguments[0]);
            if (node.arguments.length >= 2) {
              node.arguments[1] = unsign(node.arguments[1]);
            }
          }
        } else if (node.callee.property.name === 'copyWithin') {
          node.arguments[0] = unsign(node.arguments[0]);
          node.arguments[1] = unsign(node.arguments[1]);
          if (node.arguments.length >= 3) {
            node.arguments[2] = unsign(node.arguments[2]);
          }
        }
      }
    }
  });
}

function isHEAPAccess(node) {
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.computed && // notice a[X] but not a.X
    isEmscriptenHEAP(node.object.name)
  );
}

// Replace direct HEAP* loads/stores with calls into C, in which ASan checks
// are applied. That lets ASan cover JS too.
function asanify(ast) {
  recursiveWalk(ast, {
    FunctionDeclaration(node, c) {
      if (node.id.type === 'Identifier' && node.id.name.startsWith('_asan_js_')) {
        // do not recurse into this js impl function, which we use during
        // startup before the wasm is ready
      } else {
        c(node.body);
      }
    },
    AssignmentExpression(node, c) {
      const target = node.left;
      const value = node.right;
      c(value);
      if (isHEAPAccess(target)) {
        // Instrument a store.
        const ptr = target.property;
        switch (target.object.name) {
          case 'HEAP8': {
            makeCallExpression(node, '_asan_js_store_1', [ptr, value]);
            break;
          }
          case 'HEAPU8': {
            makeCallExpression(node, '_asan_js_store_1u', [ptr, value]);
            break;
          }
          case 'HEAP16': {
            makeCallExpression(node, '_asan_js_store_2', [ptr, value]);
            break;
          }
          case 'HEAPU16': {
            makeCallExpression(node, '_asan_js_store_2u', [ptr, value]);
            break;
          }
          case 'HEAP32': {
            makeCallExpression(node, '_asan_js_store_4', [ptr, value]);
            break;
          }
          case 'HEAPU32': {
            makeCallExpression(node, '_asan_js_store_4u', [ptr, value]);
            break;
          }
          case 'HEAPF32': {
            makeCallExpression(node, '_asan_js_store_f', [ptr, value]);
            break;
          }
          case 'HEAPF64': {
            makeCallExpression(node, '_asan_js_store_d', [ptr, value]);
            break;
          }
          default: {
          }
        }
      } else {
        c(target);
      }
    },
    MemberExpression(node, c) {
      c(node.property);
      if (!isHEAPAccess(node)) {
        c(node.object);
      } else {
        // Instrument a load.
        const ptr = node.property;
        switch (node.object.name) {
          case 'HEAP8': {
            makeCallExpression(node, '_asan_js_load_1', [ptr]);
            break;
          }
          case 'HEAPU8': {
            makeCallExpression(node, '_asan_js_load_1u', [ptr]);
            break;
          }
          case 'HEAP16': {
            makeCallExpression(node, '_asan_js_load_2', [ptr]);
            break;
          }
          case 'HEAPU16': {
            makeCallExpression(node, '_asan_js_load_2u', [ptr]);
            break;
          }
          case 'HEAP32': {
            makeCallExpression(node, '_asan_js_load_4', [ptr]);
            break;
          }
          case 'HEAPU32': {
            makeCallExpression(node, '_asan_js_load_4u', [ptr]);
            break;
          }
          case 'HEAPF32': {
            makeCallExpression(node, '_asan_js_load_f', [ptr]);
            break;
          }
          case 'HEAPF64': {
            makeCallExpression(node, '_asan_js_load_d', [ptr]);
            break;
          }
          default: {
          }
        }
      }
    },
  });
}

function multiply(value, by) {
  return createNode({
    type: 'BinaryExpression',
    left: value,
    operator: '*',
    right: createLiteral(by),
  });
}

// Replace direct heap access with SAFE_HEAP* calls.
function safeHeap(ast) {
  recursiveWalk(ast, {
    FunctionDeclaration(node, c) {
      if (
        node.id.type === 'Identifier' &&
        (node.id.name.startsWith('SAFE_HEAP') ||
          node.id.name === 'setValue_safe' ||
          node.id.name === 'getValue_safe')
      ) {
        // do not recurse into this js impl function, which we use during
        // startup before the wasm is ready
      } else {
        c(node.body);
      }
    },
    AssignmentExpression(node, c) {
      const target = node.left;
      const value = node.right;
      c(value);
      if (isHEAPAccess(target)) {
        // Instrument a store.
        const ptr = target.property;
        switch (target.object.name) {
          case 'HEAP8':
          case 'HEAPU8': {
            makeCallExpression(node, 'SAFE_HEAP_STORE', [ptr, value, createLiteral(1)]);
            break;
          }
          case 'HEAP16':
          case 'HEAPU16': {
            makeCallExpression(node, 'SAFE_HEAP_STORE', [
              multiply(ptr, 2),
              value,
              createLiteral(2),
            ]);
            break;
          }
          case 'HEAP32':
          case 'HEAPU32': {
            makeCallExpression(node, 'SAFE_HEAP_STORE', [
              multiply(ptr, 4),
              value,
              createLiteral(4),
            ]);
            break;
          }
          case 'HEAPF32': {
            makeCallExpression(node, 'SAFE_HEAP_STORE_D', [
              multiply(ptr, 4),
              value,
              createLiteral(4),
            ]);
            break;
          }
          case 'HEAPF64': {
            makeCallExpression(node, 'SAFE_HEAP_STORE_D', [
              multiply(ptr, 8),
              value,
              createLiteral(8),
            ]);
            break;
          }
        }
      } else {
        c(target);
      }
    },
    MemberExpression(node, c) {
      c(node.property);
      if (!isHEAPAccess(node)) {
        c(node.object);
      } else {
        // Instrument a load.
        const ptr = node.property;
        switch (node.object.name) {
          case 'HEAP8': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD', [ptr, createLiteral(1), createLiteral(0)]);
            break;
          }
          case 'HEAPU8': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD', [ptr, createLiteral(1), createLiteral(1)]);
            break;
          }
          case 'HEAP16': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD', [
              multiply(ptr, 2),
              createLiteral(2),
              createLiteral(0),
            ]);
            break;
          }
          case 'HEAPU16': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD', [
              multiply(ptr, 2),
              createLiteral(2),
              createLiteral(1),
            ]);
            break;
          }
          case 'HEAP32': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD', [
              multiply(ptr, 4),
              createLiteral(4),
              createLiteral(0),
            ]);
            break;
          }
          case 'HEAPU32': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD', [
              multiply(ptr, 4),
              createLiteral(4),
              createLiteral(1),
            ]);
            break;
          }
          case 'HEAPF32': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD_D', [
              multiply(ptr, 4),
              createLiteral(4),
              createLiteral(0),
            ]);
            break;
          }
          case 'HEAPF64': {
            makeCallExpression(node, 'SAFE_HEAP_LOAD_D', [
              multiply(ptr, 8),
              createLiteral(8),
              createLiteral(0),
            ]);
            break;
          }
          default: {
          }
        }
      }
    },
  });
}

// Name minification

const RESERVED = new Set([
  'do',
  'if',
  'in',
  'for',
  'new',
  'try',
  'var',
  'env',
  'let',
  'case',
  'else',
  'enum',
  'void',
  'this',
  'void',
  'with',
]);
const VALID_MIN_INITS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$';
const VALID_MIN_LATERS = VALID_MIN_INITS + '0123456789';

const minifiedNames = [];
const minifiedState = [0];

// Make sure the nth index in minifiedNames exists. Done 100% deterministically.
function ensureMinifiedNames(n) {
  while (minifiedNames.length < n + 1) {
    // generate the current name
    let name = VALID_MIN_INITS[minifiedState[0]];
    for (let i = 1; i < minifiedState.length; i++) {
      name += VALID_MIN_LATERS[minifiedState[i]];
    }
    if (!RESERVED.has(name)) minifiedNames.push(name);
    // increment the state
    let i = 0;
    while (1) {
      minifiedState[i]++;
      if (minifiedState[i] < (i === 0 ? VALID_MIN_INITS : VALID_MIN_LATERS).length) break;
      // overflow
      minifiedState[i] = 0;
      i++;
      // will become 0 after increment in next loop head
      if (i === minifiedState.length) minifiedState.push(-1);
    }
  }
}

function minifyLocals(ast) {
  // We are given a mapping of global names to their minified forms.
  assert(extraInfo && extraInfo.globals);

  for (const fun of ast.body) {
    if (!fun.type === 'FunctionDeclaration') {
      continue;
    }
    // Find the list of local names, including params.
    const localNames = new Set();
    for (const param of fun.params) {
      localNames.add(param.name);
    }
    simpleWalk(fun, {
      VariableDeclaration(node, c) {
        for (const dec of node.declarations) {
          localNames.add(dec.id.name);
        }
      },
    });

    function isLocalName(name) {
      return localNames.has(name);
    }

    // Names old to new names.
    const newNames = new Map();

    // The names in use, that must not be collided with.
    const usedNames = new Set();

    // Put the function name aside. We don't want to traverse it as it is not
    // in the scope of itself.
    const funId = fun.id;
    fun.id = null;

    // Find all the globals that we need to minify using pre-assigned names.
    // Don't actually minify them yet as that might interfere with local
    // variable names; just mark them as used, and what their new name will be.
    simpleWalk(fun, {
      Identifier(node, c) {
        const name = node.name;
        if (!isLocalName(name)) {
          const minified = extraInfo.globals[name];
          if (minified) {
            newNames.set(name, minified);
            usedNames.add(minified);
          }
        }
      },
      CallExpression(node, c) {
        // We should never call a local name, as in asm.js-style code our
        // locals are just numbers, not functions; functions are all declared
        // in the outer scope. If a local is called, that is a bug.
        if (node.callee.type === 'Identifier') {
          assert(!isLocalName(node.callee.name), 'cannot call a local');
        }
      },
    });

    // The first time we encounter a local name, we assign it a/ minified name
    // that's not currently in use. Allocating on demand means they're processed
    // in a predictable order, which is very handy for testing/debugging
    // purposes.
    let nextMinifiedName = 0;

    function getNextMinifiedName() {
      while (1) {
        ensureMinifiedNames(nextMinifiedName);
        const minified = minifiedNames[nextMinifiedName++];
        // TODO: we can probably remove !isLocalName here
        if (!usedNames.has(minified) && !isLocalName(minified)) {
          return minified;
        }
      }
    }

    // Traverse and minify all names. First the function parameters.
    for (const param of fun.params) {
      const minified = getNextMinifiedName();
      newNames.set(param.name, minified);
      param.name = minified;
    }

    // Label minification is done in a separate namespace.
    const labelNames = new Map();
    let nextMinifiedLabel = 0;
    function getNextMinifiedLabel() {
      ensureMinifiedNames(nextMinifiedLabel);
      return minifiedNames[nextMinifiedLabel++];
    }

    // Finally, the function body.
    recursiveWalk(fun, {
      Identifier(node) {
        const name = node.name;
        if (newNames.has(name)) {
          node.name = newNames.get(name);
        } else if (isLocalName(name)) {
          const minified = getNextMinifiedName();
          newNames.set(name, minified);
          node.name = minified;
        }
      },
      LabeledStatement(node, c) {
        if (!labelNames.has(node.label.name)) {
          labelNames.set(node.label.name, getNextMinifiedLabel());
        }
        node.label.name = labelNames.get(node.label.name);
        c(node.body);
      },
      BreakStatement(node, c) {
        if (node.label) {
          node.label.name = labelNames.get(node.label.name);
        }
      },
      ContinueStatement(node, c) {
        if (node.label) {
          node.label.name = labelNames.get(node.label.name);
        }
      },
    });

    // Finally, the function name, after restoring it.
    fun.id = funId;
    assert(extraInfo.globals.hasOwnProperty(fun.id.name));
    fun.id.name = extraInfo.globals[fun.id.name];
  }
}

function minifyGlobals(ast) {
  // The input is in form
  //
  //   function instantiate(wasmImports, wasmMemory, wasmTable) {
  //      var helper..
  //      function asmFunc(global, env, buffer) {
  //        var memory = env.memory;
  //        var HEAP8 = new global.Int8Array(buffer);
  //
  // We want to minify the interior of instantiate, basically everything but
  // the name instantiate itself, which is used externally to call it.
  //
  // This is *not* a complete minification algorithm. It does not have a full
  // understanding of nested scopes. Instead it assumes the code is fairly
  // simple - as wasm2js output is - and looks at all the minifiable names as
  // a whole. A possible bug here is something like
  //
  //   function instantiate(wasmImports, wasmMemory, wasmTable) {
  //      var x = foo;
  //      function asmFunc(global, env, buffer) {
  //        var foo = 10;
  //
  // Here foo is declared in an inner scope, and the outer use of foo looks
  // to the global scope. The analysis here only thinks something is from the
  // global scope if it is not in any var or function declaration. In practice,
  // the globals used from wasm2js output are things like Int8Array that we
  // don't declare as locals, but we should probably have a fully scope-aware
  // analysis here. FIXME

  // We must run on a singleton instantiate() function as described above.
  assert(
    ast.type === 'Program' &&
      ast.body.length === 1 &&
      ast.body[0].type === 'FunctionDeclaration' &&
      ast.body[0].id.name === 'instantiate'
  );
  const fun = ast.body[0];

  // Swap the function's name away so that we can then minify everything else.
  const funId = fun.id;
  fun.id = null;

  // Find all the declarations.
  const declared = new Set();

  // Some identifiers must be left as they are and not minified.
  const ignore = new Set();

  simpleWalk(fun, {
    FunctionDeclaration(node) {
      if (node.id) {
        declared.add(node.id.name);
      }
      for (const param of node.params) {
        declared.add(param.name);
      }
    },
    FunctionExpression(node) {
      for (const param of node.params) {
        declared.add(param.name);
      }
    },
    VariableDeclaration(node) {
      for (const decl of node.declarations) {
        declared.add(decl.id.name);
      }
    },
    MemberExpression(node) {
      // In  x.a  we must not minify a. However, for  x[a]  we must.
      if (!node.computed) {
        ignore.add(node.property);
      }
    },
  });

  // TODO: find names to avoid, that are not declared (should not happen in
  // wasm2js output)

  // Minify the names.
  let nextMinifiedName = 0;

  function getNewMinifiedName() {
    ensureMinifiedNames(nextMinifiedName);
    return minifiedNames[nextMinifiedName++];
  }

  const minified = new Map();

  function minify(name) {
    if (!minified.has(name)) {
      minified.set(name, getNewMinifiedName());
    }
    assert(minified.get(name));
    return minified.get(name);
  }

  // Start with the declared things in the lowest indices. Things like HEAP8
  // can have very high use counts.
  for (const name of declared) {
    minify(name);
  }

  // Minify all globals in function chunks, i.e. not seen here, but will be in
  // the minifyLocals work on functions.
  for (const name of extraInfo.globals) {
    declared.add(name);
    minify(name);
  }

  // Replace the names with their minified versions.
  simpleWalk(fun, {
    Identifier(node) {
      if (declared.has(node.name) && !ignore.has(node)) {
        node.name = minify(node.name);
      }
    },
  });

  // Restore the name
  fun.id = funId;

  // Emit the metadata
  const json = {};
  for (const x of minified.entries()) json[x[0]] = x[1];

  suffix = '// EXTRA_INFO:' + JSON.stringify(json);
}

// Utilities

function reattachComments(ast, comments) {
  const symbols = [];

  // Collect all code symbols
  ast.walk(
    new terser.TreeWalker(function (node) {
      if (node.start && node.start.pos) {
        symbols.push(node);
      }
    })
  );

  // Sort them by ascending line number
  symbols.sort((a, b) => a.start.pos - b.start.pos);

  // Walk through all comments in ascending line number, and match each
  // comment to the appropriate code block.
  for (let i = 0, j = 0; i < comments.length; ++i) {
    while (j < symbols.length && symbols[j].start.pos < comments[i].end) {
      ++j;
    }
    if (j >= symbols.length) {
      break;
    }
    if (symbols[j].start.pos - comments[i].end > 20) {
      // This comment is too far away to refer to the given symbol. Drop
      // the comment altogether.
      continue;
    }
    if (!Array.isArray(symbols[j].start.comments_before)) {
      symbols[j].start.comments_before = [];
    }
    symbols[j].start.comments_before.push(
      new terser.AST_Token({
        end: undefined,
        quote: undefined,
        raw: undefined,
        file: '0',
        comments_after: undefined,
        comments_before: undefined,
        nlb: false,
        endpos: undefined,
        endcol: undefined,
        endline: undefined,
        pos: undefined,
        col: undefined,
        line: undefined,
        value: comments[i].value,
        type: comments[i].type == 'Line' ? 'comment' : 'comment2',
        flags: 0,
      })
    );
  }
}

// Main

let suffix = '';

const argv = process.argv.slice(2);
// If enabled, output retains parentheses and comments so that the
// output can further be passed out to Closure.
let closureFriendly = argv.indexOf('--closureFriendly');
if (closureFriendly != -1) {
  argv.splice(closureFriendly, 1);
  closureFriendly = true;
} else {
  closureFriendly = false;
}

let exportES6 = argv.indexOf('--exportES6');
if (exportES6 != -1) {
  argv.splice(exportES6, 1);
  exportES6 = true;
} else {
  exportES6 = false;
}

let outfile;
const outfileIndex = argv.indexOf('-o');
if (outfileIndex != -1) {
  outfile = argv[outfileIndex + 1];
  argv.splice(outfileIndex, 2);
}

const infile = argv[0];
const passes = argv.slice(1);

const input = read(infile);
const extraInfoStart = input.lastIndexOf('// EXTRA_INFO:');
let extraInfo = null;
if (extraInfoStart > 0) {
  extraInfo = JSON.parse(input.substr(extraInfoStart + 14));
}
// Collect all JS code comments to this array so that we can retain them in the outputted code
// if --closureFriendly was requested.
const sourceComments = [];
let ast;
try {
  ast = acorn.parse(input, {
    // Keep in sync with --language_in that we pass to closure in building.py
    ecmaVersion: 2020,
    preserveParens: closureFriendly,
    onComment: closureFriendly ? sourceComments : undefined,
    sourceType: exportES6 ? 'module' : 'script',
  });
} catch (err) {
  err.message += (() => {
    let errorMessage = '\n' + input.split(acorn.lineBreak)[err.loc.line - 1] + '\n';
    let column = err.loc.column;
    while (column--) {
      errorMessage += ' ';
    }
    errorMessage += '^\n';
    return errorMessage;
  })();
  throw err;
}

let minifyWhitespace = false;
let noPrint = false;
let verbose = false;

const registry = {
  JSDCE: runJSDCE,
  AJSDCE: runAJSDCE,
  applyImportAndExportNameChanges: applyImportAndExportNameChanges,
  emitDCEGraph: emitDCEGraph,
  applyDCEGraphRemovals: applyDCEGraphRemovals,
  minifyWhitespace: () => {
    minifyWhitespace = true;
  },
  noPrint: () => {
    noPrint = true;
  },
  verbose: () => {
    verbose = true;
  },
  // TODO: remove 'last' in the python driver code
  last: () => {},
  dump: () => dump(ast),
  littleEndianHeap: littleEndianHeap,
  growableHeap: growableHeap,
  unsignPointers: unsignPointers,
  minifyLocals: minifyLocals,
  asanify: asanify,
  safeHeap: safeHeap,
  minifyGlobals: minifyGlobals,
};

passes.forEach(pass => registry[pass](ast));

if (!noPrint) {
  const terserAst = terser.AST_Node.from_mozilla_ast(ast);

  if (closureFriendly) {
    reattachComments(terserAst, sourceComments);
  }

  let output = terserAst.print_to_string({
    beautify: !minifyWhitespace,
    indent_level: minifyWhitespace ? 0 : 1,
    keep_quoted_props: true, // for closure
    comments: true, // for closure as well
  });

  output += '\n';
  if (suffix) {
    output += suffix + '\n';
  }

  if (outfile) {
    fs.writeFileSync(outfile, output);
  } else {
    // Simply using `fs.writeFileSync` on `process.stdout` has issues with
    // large amount of data. It can cause:
    //   Error: EAGAIN: resource temporarily unavailable, write
    process.stdout.write(output);
  }
}
