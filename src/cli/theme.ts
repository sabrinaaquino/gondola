// Terminal styling. Colors are disabled automatically when stdout is not a TTY
// (piped/redirected output) or when NO_COLOR is set, so scripted use stays clean.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function paint(code: string): (text: string) => string {
  return (text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
}

export const theme = {
  enabled: useColor,
  dim: paint("2"),
  bold: paint("1"),
  cyan: paint("36"),
  green: paint("32"),
  yellow: paint("33"),
  red: paint("31"),
  magenta: paint("35"),
};

export const PROMPT = theme.cyan("› ");
