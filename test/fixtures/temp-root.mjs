import {tmpdir as osTmpdir} from 'node:os';
import {realpathSync} from 'node:fs';

// macOS can expose its trusted OS temp base through /var -> /private/var.
// Canonicalize the base before creating fixtures; explicit state links stay refused.
export function tmpdir(){return realpathSync(osTmpdir());}
