import {ChildProcess, execFile, spawn} from 'node:child_process';
import {readFile, readdir} from 'node:fs/promises';
import {win32} from 'node:path';
import {isolatedEnvironment} from './permission-scope.mjs';

const MAX_PROCESSES = 32768, MAX_OWNED = 4096;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = () => new Error('Owned engine process cleanup could not be verified.');
const live = row => row && !['Z', 'X', 'x'].includes(row.state);
export const sameProcess = (a, b) => !!a && !!b && Number.isSafeInteger(a.pid) && a.pid > 0 && a.pid === b.pid
  && typeof a.birth === 'string' && a.birth.length > 0 && a.birth === b.birth;
export function ownedGroupMembers(table, root, known, pid) {
  if (!root || table.has(pid) && !sameProcess(root, table.get(pid))) throw failure();
  const members = [...table.values()].filter(row => row.group === pid);
  if (members.some(row => row.session !== root.session)) throw failure();
  // A number/session match alone cannot re-anchor a vanished lifetime. Keep
  // at least one previously observed birth, even when the direct root is gone.
  if (members.some(live) && !members.some(row => sameProcess(known.get(row.pid), row))) throw failure();
  return members;
}
const remaining = (deadline, maximum) => {const ms = Math.min(maximum, deadline - Date.now()); if (ms <= 0) throw failure(); return ms;};
function execute(executable, args, deadline, maximum = 5000) {
  return new Promise((resolve, reject) => execFile(executable, args, {
    timeout: remaining(deadline, maximum), maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true, shell: false,
    env: isolatedEnvironment(process.env, process.platform === 'win32' ? {} : {PATH: '/usr/bin:/bin', LC_ALL: 'C'}),
  }, (error, stdout) => error ? reject(failure()) : resolve(stdout)));
}
const windowsDirectory = () => win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
export function parseDarwinProcessTable(text) {
  return text.split('\n').filter(line => line.trim()).map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z?+<>]+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s*$/.exec(line); if (!m) throw failure();
    return {pid: Number(m[1]), ppid: Number(m[2]), group: Number(m[3]), session: m[4], state: m[5][0], birth: m[6].replace(/\s+/g, ' ')};
  });
}
async function processTable(deadline = Date.now() + 5000) {
  let rows;
  if (process.platform === 'win32') {
    const executable = win32.join(windowsDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Stock module only. Read identity/ancestry, never arguments or environment.
    const script = "$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';Import-Module ($PSHOME+'\\Modules\\CimCmdlets\\CimCmdlets.psd1');$PSModuleAutoLoadingPreference='None';foreach($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate)){if($null -eq $p.CreationDate){throw 'identity'};[Console]::WriteLine(('{0} {1} {2}' -f $p.ProcessId,$p.ParentProcessId,$p.CreationDate.ToUniversalTime().Ticks))}";
    const text = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', script], deadline);
    rows = text.split(/\r?\n/).filter(line => line.trim()).map(line => {
      const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim()); if (!m) throw failure();
      return {pid: Number(m[1]), ppid: Number(m[2]), birth: m[3], state: 'R'};
    });
  } else if (process.platform === 'linux') {
    const names = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
    if (names.length > MAX_PROCESSES) throw failure(); rows = [];
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining(deadline, 2500));
    try {
      for (let offset = 0; offset < names.length; offset += 32) {
        controller.signal.throwIfAborted();
        const batch = await Promise.all(names.slice(offset, offset + 32).map(async name => {
          let text;
          try {text = await readFile(`/proc/${name}/stat`, {encoding: 'utf8', signal: controller.signal});}
          catch (error) {if (['ENOENT', 'ESRCH'].includes(error.code)) return; throw error;}
          const end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
          if (end < 0 || fields.length < 20 || !/^[RSDZTtXxKWPI]$/.test(fields[0]) || !/^\d+$/.test(fields[19])) throw failure();
          return {pid: Number(name), ppid: Number(fields[1]), group: Number(fields[2]), session: Number(fields[3]), state: fields[0], birth: fields[19]};
        })); rows.push(...batch.filter(Boolean));
      }
    } finally {clearTimeout(timer);}
  } else if (process.platform === 'darwin') {
    const text = await execute('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,sess=,stat=,lstart='], deadline, 2500);
    rows = parseDarwinProcessTable(text);
  } else throw failure();
  if (rows.length > MAX_PROCESSES || rows.some(row => !Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0)
    || new Set(rows.map(row => row.pid)).size !== rows.length) throw failure();
  return new Map(rows.map(row => [row.pid, row]));
}

function closeWindows(pid, root, known, originalAlive) {
  // One on-demand stock PowerShell process. Its handshake waits for the Node
  // ChildProcess lifetime check before it can kill an uncaptured root PID.
  const records = JSON.stringify([...known.values()].map(row => ({pid: row.pid, birth: row.birth})));
  if (records.length > 16000) return Promise.reject(failure());
  const script = `$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';Import-Module ($PSHOME+'\\Modules\\CimCmdlets\\CimCmdlets.psd1');Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1');$PSModuleAutoLoadingPreference='None';
$owned=@{};foreach($r in (ConvertFrom-Json '${records}')){$owned[[int]$r.pid]=[string]$r.birth};$rootId=${pid};$rootBirth='${root?.birth || ''}';
function Table {$result=@{};foreach($p in (Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate)){if($p.ProcessId -eq 0){continue};if($null -eq $p.CreationDate){throw 'identity'};$result[[int]$p.ProcessId]=@{pid=[int]$p.ProcessId;ppid=[int]$p.ParentProcessId;birth=[string]$p.CreationDate.ToUniversalTime().Ticks}};if($result.Count -gt ${MAX_PROCESSES}){throw 'limit'};return ,$result}
$table=Table;if($table.ContainsKey($rootId)){if($rootBirth -and $rootBirth -ne $table[$rootId].birth){throw 'identity'};$rootBirth=$table[$rootId].birth;$owned[$rootId]=$rootBirth}else{if(-not $rootBirth){throw 'unverified'}};
for($pass=0;$pass -lt ${MAX_OWNED};$pass++){$changed=$false;foreach($r in $table.Values){if($owned.ContainsKey($r.ppid) -and $table.ContainsKey($r.ppid) -and $owned[$r.ppid] -eq $table[$r.ppid].birth -and -not $owned.ContainsKey($r.pid) -and [long]$r.birth -ge [long]$owned[$r.ppid]){if($owned.Count -ge ${MAX_OWNED}){throw 'limit'};$owned[$r.pid]=$r.birth;$changed=$true}};if(-not $changed){break}};
[Console]::WriteLine('READY');if([Console]::ReadLine() -ne 'OWNED'){throw 'unverified'};
$taskkill=$env:SystemRoot+'\\System32\\taskkill.exe';$ids=@($rootId)+@($owned.Keys | Where-Object {$_ -ne $rootId});foreach($id in $ids){if(-not $owned.ContainsKey($id)){continue};$current=Table;if($current.ContainsKey($id) -and $current[$id].birth -eq $owned[$id]){$savedNativePreference=$ErrorActionPreference;try{$ErrorActionPreference='Continue';& $taskkill /PID $id /T /F > $null 2>&1}finally{$ErrorActionPreference=$savedNativePreference};if($LASTEXITCODE -ne 0){$check=Table;if($check.ContainsKey($id) -and $check[$id].birth -eq $owned[$id]){throw 'termination'}}}};
$deadline=[DateTime]::UtcNow.AddMilliseconds(1500);do{$current=Table;$live=$false;foreach($id in $owned.Keys){if($current.ContainsKey($id) -and $current[$id].birth -eq $owned[$id]){$live=$true;break}};if(-not $live){[Console]::WriteLine('DONE');exit 0};[Threading.Thread]::Sleep(25)}while([DateTime]::UtcNow -lt $deadline);throw 'live';`;
  const executable = win32.join(windowsDirectory(), 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const helper = spawn(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: isolatedEnvironment(process.env), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '', bytes = 0, done = false, settled = false;
    const finish = error => {if (settled) return; settled = true; clearTimeout(timer); helper.stdin.destroy(); helper.stdout.destroy(); helper.stderr.destroy(); error ? reject(failure()) : resolve();};
    const timer = setTimeout(() => {helper.kill('SIGKILL'); finish(failure());}, 15000);
    helper.stdout.setEncoding('utf8'); helper.stderr.resume();
    helper.stdout.on('data', chunk => {
      bytes += Buffer.byteLength(chunk); if (bytes > 4096) {helper.kill('SIGKILL'); finish(failure()); return;}
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line === 'READY') helper.stdin.end(root || originalAlive() ? 'OWNED\n' : 'REFUSE\n');
        else if (line === 'DONE') done = true;
        else if (line) {helper.kill('SIGKILL'); finish(failure());}
      }
    });
    // Exit can precede delivery of the final stdout marker. The existing
    // deadline bounds pipe closure; only close confirms buffered data drained.
    helper.on('error', () => finish(failure())); helper.once('close', code => finish(code === 0 && done ? undefined : failure()));
    helper.stdin.on('error', () => {}); helper.stdout.on('error', () => finish(failure())); helper.stderr.on('error', () => finish(failure()));
  });
}

/** Own only an actual spawned child. Unix requires detached:true, without
 * unref. On Windows, exit before any ancestry capture is unverified: the OS
 * does not provide a provable tree after an unobserved parent is gone.
 */
export function ownProcess(child) {
  if (!(child instanceof ChildProcess)) throw new TypeError('A spawned engine child is required.');
  const pid = child.pid;
  let exited = child.exitCode !== null || child.signalCode !== null, spawnFailed = !pid;
  let root, groupGone = false, closing;
  const known = new Map();
  child.once('exit', () => {exited = true;});
  // An error after spawn (for example IPC/send failure) does not relinquish
  // ownership. Only an absent spawned PID is a start failure.
  child.once('error', () => {if (!pid) spawnFailed = true;});
  function remember(table) {
    const current = table.get(pid);
    if (root && current && !sameProcess(root, current)) throw failure();
    if (!root && !exited && live(current)) {
      root = current;
      if (process.platform !== 'win32' && current.group !== pid) throw failure();
      known.set(pid, current);
    }
    if (!root) throw failure();
    // Linear bounded ancestry expansion, only from still-matching lifetime
    // identities. A recycled numeric parent can never add descendants.
    const children=new Map();
    for(const row of table.values()){if(!children.has(row.ppid))children.set(row.ppid,[]);children.get(row.ppid).push(row);}
    const queue=[...known.values()].filter(row=>sameProcess(row,table.get(row.pid)));
    for(let index=0;index<queue.length;index++){
      const parent=queue[index];
      for(const row of children.get(parent.pid)||[]){
        if(known.has(row.pid)||process.platform!=='darwin'&&BigInt(row.birth)<BigInt(parent.birth))continue;
        if(known.size>=MAX_OWNED)throw failure();known.set(row.pid,row);queue.push(row);
      }
    }
    return table;
  }
  async function capture(deadline = Date.now() + 5000) {
    if (spawnFailed) return;
    try {return remember(await processTable(deadline));} catch {throw failure();}
  }
  async function signalKnown(signal, table, deadline) {
    if (process.platform !== 'win32' && !groupGone) {
      const members = ownedGroupMembers(table, root, known, pid);
      if (!members.length) groupGone = true;
      else {
        if (members.some(live)) try {process.kill(-pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw failure();}
      }
    }
    const records = [...known.values()].reverse();
    for (const record of records) {
      const current = table.get(record.pid);
      if (!sameProcess(record, current) || !live(current) || current.group === pid) continue;
      // Birth checked immediately before individual signals. Root tree utility
      // runs before stdin EOF, while this original child is still observed alive.
      const checked = (await processTable(deadline)).get(record.pid);
      if (!sameProcess(record, checked) || !live(checked)) continue;
      // Darwin ps lstart has second precision, insufficient for an escaped
      // individual PID. The private process group remains the safe boundary.
      if (process.platform === 'darwin') {
        if (signal === 'SIGTERM') continue; // Observe natural exit during the existing grace; never signal this PID.
        throw failure();
      }
      try {process.kill(record.pid, signal);} catch (error) {if (error.code !== 'ESRCH') throw failure();}
    }
  }
  function stillRunning(table) {
    if (process.platform !== 'win32' && !groupGone) {
      const members = ownedGroupMembers(table, root, known, pid);
      if (!members.length) groupGone = true;
      if (members.some(live)) return true;
    }
    return [...known.values()].some(row => sameProcess(row, table.get(row.pid)) && live(table.get(row.pid)));
  }
  function close() {
    if (closing) return closing;
    closing = (async () => {
      if (spawnFailed) return;
      const totalDeadline = Date.now() + (process.platform === 'win32' ? 15000 : 5000);
      try {
        if (process.platform === 'win32') return await closeWindows(pid, root, known, () => !exited);
        const table = await capture(totalDeadline); await signalKnown('SIGTERM', table, totalDeadline);
        const grace = Date.now() + 250; let current;
        do {current = remember(await processTable(totalDeadline)); if (!stillRunning(current)) return; await delay(25);} while (Date.now() < grace);
        await signalKnown('SIGKILL', current, totalDeadline);
        const deadline = Math.min(totalDeadline, Date.now() + 1500);
        do {current = remember(await processTable(totalDeadline)); if (!stillRunning(current)) return; await delay(25);} while (Date.now() < deadline);
        throw failure();
      } catch {
        // Preserve the failure, but still stop the exact original OS child
        // handle. An unknown tree is never permission to signal guessed PIDs.
        if (!exited) try {child.kill('SIGKILL');} catch {}
        throw failure();
      }
      finally {child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();}
    })(); return closing;
  }
  return {capture, close};
}
