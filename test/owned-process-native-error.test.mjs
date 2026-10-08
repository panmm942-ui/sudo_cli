import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {win32} from 'node:path';
import {runFixtureProcess} from './fixtures/native-process.mjs';

const quote=value=>"'"+value.replaceAll("'","''")+"'";
const nativeInvocation='& $taskkill /PID $id /T /F > $null 2>&1';
const fixedNativeError="process.stderr.write('FIXED_NATIVE_ERROR\\n');process.exit(1)";

async function control(current) {
  const source=await readFile(new URL('../src/owned-process.mjs',import.meta.url),'utf8');
  const begin=source.indexOf('$ids=@($rootId)+@($owned.Keys'),end=source.indexOf('\n$deadline=',begin);
  assert.ok(begin>0&&end>begin,'Production Windows termination loop must be extracted.');
  const exact=source.slice(begin,end);
  assert.equal(exact.split(nativeInvocation).length,2,'Only the native executable invocation is substituted.');
  const flow=exact.replace(nativeInvocation,'& $taskkill @nativeArguments > $null 2>&1');
  // The first table permits termination; the follow-up represents a child that
  // exited, a recycled PID, or the same recorded birth still running. No host
  // process table or real taskkill command is used by this control.
  const followup=current==='absent'?'return ,@{}':`return ,@{101=@{birth='${current==='matching'?'42':'43'}'}}`;
  const script="$ErrorActionPreference='Stop';$env:PSModulePath=$PSHOME+'\\Modules';Import-Module ($PSHOME+'\\Modules\\CimCmdlets\\CimCmdlets.psd1');Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1');$PSModuleAutoLoadingPreference='None';"+
    `$taskkill=${quote(process.execPath)};$nativeArguments=@('-e',${quote(fixedNativeError)});$rootId=101;$owned=@{101='42'};$script:tableChecks=0;$passed=$false;$nativeError=$false;$terminationError=$false;`+
    `function Table {$script:tableChecks++;if($script:tableChecks -eq 1){return ,@{101=@{birth='42'}}};${followup}};`+
    `try{${flow};$passed=$true}catch{$nativeError=$_.FullyQualifiedErrorId -like '*NativeCommandError*';$terminationError=$_.Exception.Message -eq 'termination'};`+
    "[Console]::WriteLine(('{\"passed\":'+$passed.ToString().ToLowerInvariant()+',\"nativeError\":'+$nativeError.ToString().ToLowerInvariant()+',\"terminationError\":'+$terminationError.ToString().ToLowerInvariant()+',\"tableChecks\":'+$script:tableChecks+',\"preferenceRestored\":'+($ErrorActionPreference -eq 'Stop').ToString().ToLowerInvariant()+',\"nativeExitCode\":'+[int]$LASTEXITCODE+'}'))";
  const executable=win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=await runFixtureProcess(executable,['-NoProfile','-NonInteractive','-Command',script],{timeoutMs:15000,maxBytes:4096});
  assert.equal(result.exitCode,0);
  const observed=JSON.parse(result.stdout.trim());
  assert.deepEqual(Object.keys(observed).sort(),['nativeError','nativeExitCode','passed','preferenceRestored','tableChecks','terminationError']);
  return observed;
}

for(const [name,current,passed] of [['absent child','absent',true],['recycled child PID','recycled',true],['matching live child','matching',false]]) {
  test(`Windows native stderr preserves the follow-up birth check for an ${name}`,{skip:process.platform!=='win32',timeout:20000},async()=>{
    const observed=await control(current);
    assert.equal(observed.nativeError,false,'A fixed native stderr record must not bypass the follow-up identity read.');
    assert.equal(observed.nativeExitCode,1,'The nonzero native exit remains available to the production flow.');
    assert.equal(observed.tableChecks,2,'Both the pre-termination and post-failure identity tables must be read.');
    assert.equal(observed.preferenceRestored,true,'The scoped native error preference must restore Stop.');
    assert.equal(observed.passed,passed);
    assert.equal(observed.terminationError,!passed,'Only the matching live birth must reject termination.');
  });
}
