/**
 * Markdownlint-cli2 with its arguments on stdin. A command line has a limit, about 32,000 characters on
 * Windows, and the list of a large repository passes it.
 */

import { json } from "node:stream/consumers";
import { main } from "markdownlint-cli2";

try {
  // Not `readFileSync(0)`: a pipe with nothing in it yet answers EAGAIN, which a long list reaches.
  const argv = await json(process.stdin) as string[];
  process.exitCode = await main({ argv, logMessage: console.log, logError: console.error });
} catch (error) {
  console.error(error);
  // Node exits 1 on an uncaught error, which `lint.ts` would read as findings.
  process.exitCode = 2;
}
