// QWERTY ↔ ЙЦУКЕН keyboard layout mapping.
// Each pair maps characters produced by the same physical key.
const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,./~QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>?";
const RU = "ёйцукенгшщзхъфывапролджэячсмитьбю.ЁЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ,";

const enToRu = new Map<string, string>();
const ruToEn = new Map<string, string>();

for (let i = 0; i < EN.length; i++) {
  enToRu.set(EN[i], RU[i]);
  ruToEn.set(RU[i], EN[i]);
}

/** Transliterate a string as if typed on the other keyboard layout (EN↔RU). */
export function transliterateLayout(text: string): string {
  let result = "";
  for (const ch of text) {
    result += enToRu.get(ch) ?? ruToEn.get(ch) ?? ch;
  }
  return result;
}
