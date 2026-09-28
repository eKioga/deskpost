/**
 * One question at a terminal, answered only by what is typed AFTER it appears (S56, Eric's run, finding 14).
 *
 * THE ANSWER IS TYPED AFTER THE QUESTION. In Eric's first fresh install, in an Orca tab, the answers landed one
 * prompt early: a word typed ahead answered the Library question, an Enter answered the plan screen before it could
 * be read, and a folder meant for `[p]` reached the fork. The one screen a reader is meant to read before anything
 * is written had been consumed by type-ahead. So a question first lets the terminal hand over whatever is already
 * buffered, sets it aside (a half-typed line too), says so in one line, and only then shows its prompt.
 *
 * CTRL+C IS NOT THE END OF INPUT. A terminal readline closes on Ctrl+C, and the menu reported that as "its input
 * ended", which reads like a fault; in many terminals Ctrl+C is also copy. It is its own outcome here.
 *
 * The readline is opened per question and closed after it, as the menu's always was, so nothing holds the terminal
 * when an agent is started.
 */
import * as readline from 'node:readline';

/** How long buffered input is given to arrive before the prompt is shown: well below what a reader notices. */
const SETTLE_MS = 40;

export class InputEnded extends Error {}
export class Interrupted extends Error {}

export const SET_ASIDE_NOTE = '(What was typed before this question was set aside; answer it now.)';

export function askAtTerminal(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let ready = false;
    let setAside = false;
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      rl.close();
      outcome();
    };
    rl.on('line', (line) => {
      if (!ready) {
        setAside = true;
        return;
      }
      finish(() => resolve(line.trim()));
    });
    rl.on('SIGINT', () => finish(() => reject(new Interrupted('Ctrl+C: nothing was chosen.'))));
    rl.on('close', () => {
      if (settled) return;
      settled = true;
      reject(new InputEnded('input ended'));
    });
    setTimeout(() => {
      if (settled) return;
      if (rl.line) {
        setAside = true;
        rl.write(null, { ctrl: true, name: 'u' });
      }
      if (setAside) process.stdout.write(SET_ASIDE_NOTE + '\n');
      ready = true;
      rl.setPrompt(prompt);
      rl.prompt();
    }, SETTLE_MS);
  });
}
