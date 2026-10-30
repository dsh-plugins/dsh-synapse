import { GroupMessageWSMSG, Message, TextMessage } from '@/type';
import { getFeatureGroups } from '@/config/features';

export class ParenthesesMatching {
  static readonly bracketPairs: Record<string, string> = {};
  static readonly closingBrackets: Set<string> = new Set();
  static readonly bracketTypeMap: Record<string, string> = {};
  static readonly reversePairs: Record<string, string> = {};

  static {
    ParenthesesMatching.add('()', 'paren');
    ParenthesesMatching.add('（）', 'full width paren');
    ParenthesesMatching.add('⁽⁾', 'superscript paren');
    ParenthesesMatching.add('₍₎', 'subscript paren');
    ParenthesesMatching.add('︵︶', 'vertical paren');
    ParenthesesMatching.add('[]', 'square');
    ParenthesesMatching.add('［］', 'full width square');
    ParenthesesMatching.add('【】', 'solid square');
    ParenthesesMatching.add('〖〗', 'hollow square');
    ParenthesesMatching.add('︗︘', 'vertical hollow square');
    ParenthesesMatching.add('︻︼', 'vertical solid square');
    ParenthesesMatching.add('{}', 'brace');
    ParenthesesMatching.add('﹛﹜', 'full width brace');
    ParenthesesMatching.add('︷︸', 'vertical brace');
    ParenthesesMatching.add('<>', 'angle');
    ParenthesesMatching.add('‹›', 'angle');
    ParenthesesMatching.add('︿﹀', 'vertical angle');
    ParenthesesMatching.add('“”', 'full width quote');
    ParenthesesMatching.add('‘’', 'full width single quote');
    ParenthesesMatching.add('「」', 'traditional quote');
    ParenthesesMatching.add('『』', 'hollow traditional quote');
    ParenthesesMatching.add('⎡⎦', 'long traditional quote');
    ParenthesesMatching.add('⎣⎤', 'reverse traditional quote');
    ParenthesesMatching.add('﹁﹂', 'vertical traditional quote');
    ParenthesesMatching.add('﹃﹄', 'vertical hollow traditional quote');
    ParenthesesMatching.add('《》', 'book');
    ParenthesesMatching.add('︽︾', 'vertical book');
    ParenthesesMatching.add('〔〕', 'hexagonal');
    ParenthesesMatching.add('︹︺', 'vertical hexagonal');
  }

  static add(bracket: string, type: string) {
    if (bracket.length !== 2) return;
    const left = bracket[0];
    const right = bracket[1];
    if (!left || !right) return;
    ParenthesesMatching.bracketPairs[left] = right;
    ParenthesesMatching.closingBrackets.add(right);
    ParenthesesMatching.bracketTypeMap[left] = type;
    ParenthesesMatching.bracketTypeMap[right] = type;
    ParenthesesMatching.reversePairs[right] = left;
  }

  public static parenthesesMatching(msg: GroupMessageWSMSG, sentMessage: Message[]) {
    if (!getFeatureGroups('parentheses').includes(msg.group_id)) return;
    const receivedMessage: TextMessage[] = [];
    msg.message.forEach(message => {
      if (message.type != 'text') return;
      receivedMessage.push(message);
    });
    const stack: { char: string; position: number }[] = [];
    const strMsg = receivedMessage.map(msg => msg.data.text).join(' ');
    for (let i = 0; i < strMsg.length; i++) {
      const char: string = strMsg[i]!;
      if (ParenthesesMatching.bracketPairs[char]) {
        stack.push({ char, position: i });
      } else if (ParenthesesMatching.closingBrackets.has(char)) {
        const expected = ParenthesesMatching.reversePairs[char];
        const charType = ParenthesesMatching.bracketTypeMap[char];
        if (stack.length > 0 && stack[stack.length - 1]!.char === expected) {
          stack.pop();
        } else {
          let errorMsg = `括号匹配错误：第 ${i + 1} 个字符 '${char}' `;
          if (stack.length === 0) {
            let errorType = '括号';
            let errorDirection = '左';
            if (charType && charType.endsWith('quote')) errorType = '引号';
            if (charType && charType.startsWith('vertical')) errorDirection = '上';
            errorMsg += `没有对应的${errorDirection}${errorType}`;
          } else {
            const topBracket = stack[stack.length - 1]!;
            const expectedClosing = ParenthesesMatching.bracketPairs[topBracket.char];
            const topType = ParenthesesMatching.bracketTypeMap[topBracket.char];
            const currentType = ParenthesesMatching.bracketTypeMap[char];

            if (topType !== currentType) {
              errorMsg += `与第 ${topBracket.position + 1} 个字符 '${topBracket.char}' 类型不匹配，期望 '${expectedClosing}'`;
            } else {
              errorMsg += `位置错误`;
            }
          }

          sentMessage.push({
            type: 'text',
            data: {
              text: errorMsg
            }
          });
          return;
        }
      }
    }

    let result = '';
    while (stack.length > 0) {
      const leftBracket = stack.pop()!;
      result += ParenthesesMatching.bracketPairs[leftBracket.char];
    }
    if (result.trim().length == 0) return;
    sentMessage.push({
      type: 'text',
      data: {
        text: result
      }
    });
  }
}
