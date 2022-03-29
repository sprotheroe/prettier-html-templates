const { breakParent, concat, group, line } = require('prettier').doc.builders;
const { isInElement, decodeInAttributes } = require('./decoder/attributes_decoder');
const { isInTableOrHead, decodeInTableOrHead } = require('./decoder/table_and_head_decoder');
const {
  isSelfClosingInText,
  decodeSelfClosingInText,
  isSelfClosingAfterOpenTag,
} = require('./decoder/html_body_decoder');

function getExpression(expressionMap, tagStart, tagEnd) {
  if (expressionMap.has(tagStart))
    return expressionMap.get(tagStart).content

  fullTag = tagStart + tagEnd
  if (expressionMap.has(fullTag))
    return expressionMap.get(fullTag).content

  throw `Expression not found: "${fullTag}"`
}

function walktree(doc, expressionMap) {
  curArray = (Array.isArray(doc)) ? doc : [doc]
  curIndex = 0

  stateStack = []
  chaseTailMode = false
  parentCandidateStateIndex = -1
  tagStart = null
  tagEnd = null


  while (true) {

    while (curIndex < curArray.length) {
      curNode = curArray[curIndex++]

      // Process this node
      switch (typeof curNode) {
        case 'string':
          if (chaseTailMode) {
            if (/\/?>/.test(curNode.trim())) {
              parentState = stateStack[parentCandidateStateIndex]
              if (parentState) {
                tagEnd = curNode
                expression =  getExpression(expressionMap, tagStart, tagEnd)
  
                parentState.array[parentState.index-1] = expression
              }

              parentCandidateStateIndex = -1
              chaseTailMode = false
            }
            else if (curNode.trim() !== '') {
              raise `ERROR - tag contained extraneous garbage!! ${curNode}`
            }
          }
          else if (/<\/?eext/.test(curNode)) {
            chaseTailMode = true
            parentCandidateStateIndex = stateStack.length-1
            tagStart = curNode
          }
          else if (/eex/.test(curNode)) {
            tag = (/eexs/.test(curNode)) ? curNode.slice(0,-1) : curNode
            expression =  getExpression(expressionMap, tag, '')
            curArray[curIndex-1] = expression
          }
          break;
        case 'object':
          key = null
          if (('contents' in curNode) && ('parts' in curNode)) {
            throw `Node contains both contents and parts ${curNode}`
          }
          else if ('contents' in curNode) {
            key = 'contents'
          }
          else if ('parts' in curNode) {
            key = 'parts'
          }
          else if (Array.isArray(curNode)) {
            state = { node: curNode, index: curIndex, array: curArray }
            stateStack.push(state)
            curArray = curNode
            curIndex = 0
          }
          else {
            if (!(curNode.type == 'break-parent' || curNode.type == 'line' || curNode.type == 'if-break')) {
              throw `Unhandled node type ${curNode.type}`
            }
          }
          if (key) {
            // TODO: DRY up this and isArray stanza above
            state = { node: curNode, index: curIndex, array: curArray }
            stateStack.push(state)
            newNode = curNode[key]
            curArray = (Array.isArray(newNode)) ? newNode : [newNode]
            curIndex = 0
          }
          break;
        default:
          throw `Unrecognised node type ${curNode}`
      }
    }

    // Finish if we are (back) at the top of the tree
    if (stateStack.length == 0)
      break;

    prevState = stateStack.pop()
    curIndex = prevState.index
    curArray = prevState.array

    if (chaseTailMode) {
      parentCandidateStateIndex = stateStack.length - 1
    }
  }
}


const decodeExpressions = (expressionMap) => {
  const opts = { removeWhitespace: false };
  const scriptTagExpressions = [];

  return (doc) => {
    walktree(doc, expressionMap)

    if (!doc.parts || (!expressionMap.size && !opts.removeWhitespace)) return doc;

    const parts = [...doc.parts];
    const decodedParts = [];

    // it also deals with head it seems
    // is in nonTextElement!
    if (isInTableOrHead(parts)) {
      // deals with non conditional expressions in table/head elements
      const partlyDecodedDoc = { ...doc, parts: decodeInTableOrHead(parts, expressionMap) };
      // deals with the rest of encoded
      return decodeExpressions(expressionMap)(partlyDecodedDoc);
    }

    if (isSelfClosingInText(parts)) {
      const { removeWhitespace, decodedParts: newDecodedParts } = decodeSelfClosingInText(parts, expressionMap);
      opts.removeWhitespace = removeWhitespace;
      decodedParts.push(...newDecodedParts);
    } else if (isInElement(parts)) {
      decodedParts.push(...decodeInAttributes(parts, expressionMap));
    } else {
      for (const part of parts) {
        if (part === '</script>') {
          for (const match of scriptTagExpressions) {
            expressionMap.delete(match);
          }

          decodedParts.push(part);
          continue;
        }
        // ORIGINAL: e <em><% e %></em>.
        // WITH:     e <em><% e %></em>.
        // WITHOUT:  e <em><% e %> </em>.
        if (part === ' ' && opts.removeWhitespace) {
          opts.removeWhitespace = false;

          continue;
        }

        // ORIGINAL: <span><% e %></span>
        // WITH:     <span><% e %></span>
        // WITHOUT:  <span><% e %> </span>
        if (part.type === 'line' && !part.soft && opts.removeWhitespace) {
          opts.removeWhitespace = false;

          continue;
        }

        // <script src="<%= static_url(@conn, "/js/app.js") %>"></script>
        if (/eex\d+eex/.test(part.contents)) {
          const decodedContents = part.contents.replace(/eex\d+eex/g, (match) => {
            const expression = expressionMap.get(match);
            expressionMap.delete(match);

            return expression.print;
          });

          decodedParts.push({ ...part, contents: decodedContents });
          continue;
        }

        // Deals with expressions between script tags
        if (/eexs\d+eexs/.test(part)) {
          const decodedPart = part.replace(/eexs\d+eexs/, (match) => {
            const expression = expressionMap.get(match);
            // Match can't be deleted immediately from expressionMap because it could be reused
            // That's why we remove them after closing script tag
            // script.html.test console.log(...)
            scriptTagExpressions.push(match);

            return expression.print;
          });

          decodedParts.push(decodedPart);
          continue;
        }

        if (isSelfClosingAfterOpenTag(part)) {
          let placeholder = part.contents.contents.parts[0].contents.contents.trim();

          if (placeholder.startsWith('/>')) {
            placeholder = placeholder.substring(2);
            decodedParts.push('/>');
          }

          const expression = expressionMap.get(placeholder);
          expressionMap.delete(placeholder);

          // !expression.afterWhitespace
          // ORIGINAL: <span><% e %></span>
          // WITH:     <span><% e %></span>
          // WITHOUT:  <span> <% e %></span>

          // !decodedParts[decodedParts.length - 1].soft
          // ORIGINAL: <div><% e %></div>
          // WITH:     <div>\n<% e %>\n</div>
          // WITHOUT:  <div><% e %>\n</div>

          // !(decodedParts.length && decodedParts[decodedParts.length - 1].soft)
          // Without first check it breaks double_expression.html.test
          if (!expression.afterWhitespace && !(decodedParts.length && decodedParts[decodedParts.length - 1].soft)) {
            decodedParts.pop();
          }

          decodedParts.push(expression.print);

          if (!expression.beforeWhitespace && expression.beforeInlineEndTag) {
            // ORIGINAL: <span><% e %></span>
            // WITH:     <span><% e %></span>
            // WITHOUT:  <span><% e %> </span>
            // expression.beforeInlineEndTag:
            // ORIGINAL: <div><% e %></div>
            // WITH:     <div><% e %></div>
            // WITHOUT:  (nothing)
            opts.removeWhitespace = true;
          } else if (expression.beforeWhitespace) {
            // ORIGINAL: <span><% e %> a</span>
            // WITH:     <span><% e %> a</span>
            // WITHOUT:  <span><% e %>a</span>
            if (part.contents.contents.parts[2] && part.contents.contents.parts[2].type === 'line') {
              decodedParts.pop();
              decodedParts.push(group(concat([expression.print, line])));
            }
          }

          continue;
        }

        const possibleTag = part.contents || part;

        const expression = /<\/?eext\d+>/.test(possibleTag) && expressionMap.get(possibleTag.trim());

        if (expression) {
          expressionMap.delete(possibleTag.trim());

          if (expression.print !== '') {
            if (expression.isMidExpression) {
              decodedParts.push(concat([expression.print, breakParent]));
            } else {
              decodedParts.push(expression.print);

              if (expression.type === 'start' || expression.type === 'middle_nested') {
                decodedParts.push(breakParent);
              }
            }

            continue;
          }

          if (expression.isMidExpression) {
            opts.removeWhitespace = true;
          }

          // cond end
          // removes empty line
          // TODO: show an example
          if (expression.type === 'end') {
            const lastPart = decodedParts.pop();
            lastPart.contents.parts.pop();
            decodedParts.push(lastPart);
          }

          continue;
        }

        decodedParts.push(part);
      }
    }

    return Object.assign({}, doc, { parts: decodedParts });
  };
};

module.exports = decodeExpressions;
