import {tmpdir as osTmpdir} from 'node:os';
import {realpathSync} from 'node:fs';

// Native resolution expands Windows case/8.3 names and macOS /var aliases
// consistently with fs.promises.realpath. Explicit state links stay refused.
export function tmpdir(){return realpathSync.native(osTmpdir());}
