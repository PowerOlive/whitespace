var  ws_asm  = (function() {
  var builtinMacros = function() {
    return {
      "include": { 
        param: ["STRING"],
        action: function (params, builder) {
          var param = params[1];
         
          var fileName = param.token;
          fileName = fileName.slice(1, fileName.length - 1);
          if (!(fileName in builder.includes)) {
            var file = ws_fs.getFile(fileName);
            if (!file) {
              throw "File not found: '" + fileName + "'.";
            }

            builder.includes[fileName] = ws_fs.openFile(file);

            if (builder.includes[fileName]) {
              var srcArr = new ws_util.StrArr(builder.includes[fileName]);
              try {
                var ext = ws_asm.compile(builder.includes[fileName], builder);
                builder.externals.push(ext);
              } catch (err) {
                if (err.program) {
                  builder.externals.push(err.program);
                  console.warn("Broken include '" + fileName + "': " + err.message);
                } else {
                  console.error(err);
                  throw "Unknown error loading '" + fileName + "'";
                }
              }
            }
          }
        }
      },
      "macro": {
        param: ["LABEL"],
        action: function (params, builder) {
          var metaTypes = { "$number": "NUMBER", "$label": "TOKEN", "$string": "STRING" };
          var macroLabel = params[1].token.replace(/:$/, "");
          var closed = false;
          var macroLabels = {};
          
          var newMacro = {
            tokens: [],
            param: [],
            action: function (params, builder) {
              builder.macroCallCounter = (builder.macroCallCounter || 0) + 1;
              var macroId = builder.macroCallCounter;
              params[0].called = (params[0].called || 0) + 1
              if (params[0].called > 16) {
                throw "Circular reference of macros";
              } 

              var toks = [];
              var pp = 1;
              for (var t in this.tokens) {
                var token = Object.assign({}, this.tokens[t]);
                if (token.token in metaTypes) {
                  toks.push(params[pp++]);
                } else {
                  if (token.token.match(/^\$\d+$/)) {
                    token.token = ".__" + macroId + "__" + token.token + "__";
                  }
                  toks.push(token);
                }
              }
             
              builder.tokens = toks.concat(builder.tokens);
            }
          };
          while (true) {
            var token = builder.tokens.shift();
            if (!token) {
              break;
            }
            if (token.type == "MACRO") {
              if (token.token == "$$") {
                closed = true;
                break;
              }
              if (token.token == "include") {
                // do nothing 
              } else if (token.token == "$redef") {
                params[1].type = "MACRO";
                newMacro.tokens.push(params[1]);
                continue;
              } else if (token.token in metaTypes) {
                newMacro.param.push(metaTypes[token.token]);
              } 
            } 
            newMacro.tokens.push(token);
          }
          if (!closed) {
            throw "Macro not closed";
          }

          builder.macros[macroLabel] = newMacro;
        }
      },
      "$$": {
        param: [],
        action: function (params, builder) {
          throw "Unexpected end of macro";
        }
      },
      "$label": {
        param: [],
        action: function (params, builde) {
          throw "Label-pop called outside of a macro";
        }
      },
      "$number": {
        param: [],
        action: function (params, builder) {
          throw "Number-pop called outside of a macro";
        }
      },
      "$string": {
        param: [],
        action: function (params, builder) {
          throw "String-pop called outside of a macro";
        }
      },
      "$redef": {
        param: [],
        action: function (params, builder) {
          throw "Can't redefine macro outside of a macro"
        }
      },
    };
  }

  var mnemo = (function () {
    var mnemoCodes = {};
    // Collect keywords
    for (var i in ws.keywords) {
      var keyword = ws.keywords[i];
      mnemoCodes[keyword.mnemo] = keyword;
    }

    return mnemoCodes;
  })(); 

  var parseWhitespace = function  (strArr) {
    var  space =  "";
    while (strArr.hasNext()  && strArr.peek().match(/[ \t\n\r]/)) {
      space  += strArr.getNext();
    }
    return {
      type: "SPACE",
      token: space
    };
  };

  var parseLineComment = function (strArr) {
    var  comment  = "";
    do {
      comment += strArr.getNext();
    } while  (strArr.hasNext() && strArr.peek() != '\n');
    return {
      type: "COMMENT",
      token: comment
    };
  };

  var parseMultiLineComment = function(strArr) {
    var comment = "";
    do {
      comment += strArr.getNext();
    } while (strArr.hasNext() && !comment.match(/{-[\s\S]*-}/));
    return {
      type: "COMMENT",
      token: comment
    };
  }

  var parseNumber = function(strArr) {
    var  numStr = "";
    while  (strArr.hasNext() && (numStr + strArr.peek()).match(/^[+-]?\d*$/)) {
      numStr +=  strArr.getNext();
    }

    if (strArr.hasNext() && !strArr.peek().match(/\s|\n|;/)) {
      throw "Invalid character in number format";
    }
    var data = parseInt(numStr);
    if (data == "NaN") {
      throw "Illegal number";
    }
    return {
      type: "NUMBER",
      token: numStr,
      data: parseInt(numStr)
    }
  };

  var getStringArray = function(str) {
    var arr = str.split('');
    var result = [];
    var escape = false;
    var chCode = "";
    for (var i = 1; i < arr.length - 1 ; i++) {
       var ch = arr[i];
       if (chCode) {
         if (ch.match(/[0-9]/)) {
           chCode += ch;
           continue;
         } else {
           result.push(parseInt(chCode));
           chCode = "";
         }
       }
       if (escape) {
          if (ch == 'n') {
            result.push('\n'.charCodeAt(0));
          } else if (ch == 't') {
            result.push('\t'.charCodeAt(0));
          } else if (ch.match(/[0-9]/)) {
            chCode += ch;
          } else {
            result.push(ch.charCodeAt(0));
          }
          escape = false;
       } else if (ch == '\\') {
         escape = true;
       } else {
         result.push(ch.charCodeAt(0));
       }
    }
    if (chCode) {
      result.push(parseInt(chCode));
    }
    if (arr[0] == '"') {
       result.push(0);
    }
    return result;
  }

  var parseString = function(strArr) {
     var line = strArr.line;
     var col = strArr.col;

     var strEnd = strArr.peek();
     var str = strArr.getNext();
     while (strArr.hasNext() && (escape || strArr.peek() != strEnd)) {
       if (strArr.peek() == '\\') {
         escape = true;
       } else {
         escape = false;
       }
       if (strArr.peek() == '\n' && !escape) {
         throw "Unexpected end of line";
       }
       str += strArr.getNext();
     }
     if (!strArr.hasNext || strArr.peek() != strEnd) {
        throw "Unterminated string";
     } else {
       str += strArr.getNext();
     }
     return {
       type: "STRING",
       token: str
     };
  }

  var parseLabel = function(strArr, builder) {
    var  label = "";
    while  (strArr.hasNext() && strArr.peek().match(/[0-9a-zA-Z_$.]/)) {
      label +=  strArr.getNext();
    }

    var type = "TOKEN";
    if (strArr.hasNext()) {
      var next = strArr.peek();
      if(!next.match(/\s|\n|:|;/)) {
        throw "Illegal character";
      } else if (next == ':') {
        strArr.getNext();
        type = "LABEL";
      }
    }

    var op = null; 
    if (type == "TOKEN") {
      if (label in mnemo) {
        type = "KEYWORD";
        op = mnemo[label];
      } else if (label in builder.macros) {
        type = "MACRO";
      }
    }

    return {
      type: type,
      token: label,
      op: op
    };

  };

  var getTokens = function(strArr, builder) {
    var tokens = [];
    while (strArr.hasNext()) {
      if (parseWhitespace(strArr).token) {
        continue;
      }
      var meta = {
        line: strArr.line,
        col: strArr.col
      };

      var next = strArr.peek();
      var token = null;
      try {
        if (next == ';' || next == '#' || (next == '-' && strArr.peek(1) == '-')) {
          token = parseLineComment(strArr);
        } else if (next == '{' && strArr.peek(1) == '-') {
          token = parseMultiLineComment(strArr);
        } else if (next.match(/\"|\'/)) {
          token = parseString(strArr);
        } else if (next.match(/[-+\d]/)) {
          token = parseNumber(strArr);
        } else {
          token = parseLabel(strArr, builder);
        }
      } catch (err) {
        if (typeof err == "string") {
           throw {
              tokens: tokens,
              meta: meta,
              message: err + " at line " + meta.line,
              line: meta.line
           }
        } else {
           throw err;
        }
      }

      token.meta = meta;

      if (token.type == "STRING") {
        token.data = getStringArray(token.token);
      }
      if (token.type != "COMMENT") {
        tokens.push(token);
      }
    }
    return tokens;
  }  

  var pushInstruction = function(builder, constr, paramNumber) {
    var instruction = new constr();
    if (typeof paramNumber != "undefined" && paramNumber != null) {
      instruction.param = { token: ws_util.getWsSignedNumber(paramNumber), value: paramNumber };
    }
    builder.pushInstruction(instruction);
  }

  var postProcess = function(builder) {
    while (builder.externals.length > 0) {
      var ext = builder.externals.shift();
      for (var i in ext.programStack) {
        var inst = ext.programStack[i];
        builder.pushInstruction(inst);
      } 
    }
    return builder.postProcess();
  };

  var checkMacroParams = function (token, builder) {
    var macro = builder.macros[token];
    if (typeof macro.action == "function") {
      var n = 0;
      for (var p in macro.param) {
        var paramType = macro.param[p];
        var parToken = builder.tokens[n++];
        if (!parToken || parToken.type != paramType) {
          return false;
        }
      }
    }
    return true;
  };

  return {
    compile: function (str, master) {
      var strArr = new ws_util.StrArr(str);
      var builder = ws.programBuilder(str, master);
      builder.macros = builder.macros || builtinMacros();
      builder.includes = builder.includes || {};
      builder.externals = builder.externals || [];
      try {
        builder.tokens = getTokens(strArr, builder);
      } catch (err) {
        if (err.tokens) {
          builder.tokens = err.tokens;
          var tokenError = err;
        } else {
          throw err;
        }
      }
      builder.asmLabeler = builder.asmLabeler || new ws_util.labelTransformer(function(counter, label) {
        return ws_util.getWsUnsignedNumber(counter);
      });

      var labeler = builder.asmLabeler;

      var parentLabel = "";

      while (builder.tokens.length > 0) {
         var token = builder.tokens.shift();
         var meta = token.meta;
         try {
           if (token.type == "LABEL") {
             var label = token.token;
             if (ws_util.isLocalLabel(label)) {
               label = parentLabel + label;
             } else {
               parentLabel = label;
             }

             if (typeof builder.labels[labeler.getLabel(label)] === "number") {
               throw "Multiple definitions of label " + label;
             }

             builder.labels[labeler.getLabel(label)] = builder.programStack.length;
             builder.asmLabels[labeler.getLabel(label)] = label;
           } else if (token.op && token.op.constr == ws.WsLabel) {
             var param = builder.tokens.shift();
             if (!param) {
               throw "Missing label";
             }
             if (param.type != "TOKEN") {
               throw "Invalid label";
             }

             var label = param.token;
             if (builder.labels[labeler.getLabel(label)]) {
               throw "Multiple definitions of label " + label;
             }

             builder.labels[labeler.getLabel(label)] = builder.programStack.length;
             builder.asmLabels[labeler.getLabel(label)] = label;
           } else if (token.token in builder.macros && checkMacroParams(token.token, builder)) {
              token.type = "MACRO"; // can be label in some cases
              var macro = builder.macros[token.token];
              if (typeof macro.action == "function") {
                var params = [token];
                for (var p in macro.param) {
                  var paramType = macro.param[p];
                  var parToken = builder.tokens.shift();
                  if (!parToken || parToken.type != paramType) {
                    throw "Expected " + paramType;
                  } else {
                    params.push(parToken);
                  }
                }
                macro.action(params, builder);
              } else {
                throw "Unimplemented macro type " + typeof macro.action;
              }
 
           } else if (token.type == "KEYWORD") {
              var op = token.op;
              var instruction = new op.constr();

              if (op.optparam === 'NUMBER' && builder.tokens[0] && builder.tokens[0].type == op.optparam) {
                pushInstruction(builder, ws.WsPush ,builder.tokens.shift().data);
              } 

              if (op.param) {
                var param = builder.tokens.shift();
                if (!param) {
                  throw "Parameter expected";
                }
                if (op.param == "NUMBER") {
                  if (param.type == "NUMBER") {
                    pushInstruction(builder, op.constr, param.data);
                  } else if (instruction instanceof ws.WsPush && param.type == "STRING") {
                    for (var i = param.data.length -1 ; i >= 0; i--) {
                      pushInstruction(builder, op.constr, param.data[i]);
                    }
                  } else {
                    throw "Unexpected token " + param.token;
                  }
                } else if (op.param == "LABEL") {
                  var instruction = new op.constr();
                  var label = param.token;
                  if (ws_util.isLocalLabel(label)) label = parentLabel + label;

                  instruction.param = {
                    token: labeler.getLabel(label), value: null, label: label
                  };
                  builder.pushInstruction(instruction); 
                } else {
                  throw "Unsupported parameter type " + op.param + " (should never happen)."
                }
              } else {
                pushInstruction(builder, op.constr);
              }
            } else if (token.token in builder.macros) {
           } else {
              throw "Unexpected token " + token.token;
           }

         } catch (err) {
           if (typeof err == "string") {
             throw {
               program: null,
               line: meta.line,
               message: err + " at line " + meta.line + "." 
             };
           } else {
             throw err;
           }
         }
      }

      if (tokenError) {
        throw {
          program: null,
          line: tokenError.meta.line,
          message: tokenError.message
        }
      }

      try {
        var program = postProcess(builder);
      } catch (err) {
        if (typeof err === "string") {
          throw {
            message: err
          }
        } else {
          throw err;
        }
      }

      return program;
    },
  };

})();

