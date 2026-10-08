import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {permissionPolicy,approvalWithinScope,isolatedEnvironment} from '../src/permission-scope.mjs';
test('Web Off full access is reduced to a sandbox and never grants network escalation',()=>{
  const policy=permissionPolicy({permissions:'allow-everything',webAccess:false,scope:'full'});
  assert.equal(policy.sandbox,'workspace-write');assert.equal(policy.networkAccess,false);
  assert.equal(approvalWithinScope({method:'item/commandExecution/requestApproval',params:{command:'curl example.com'}},{webAccess:false,scope:'project'}),false);
});
test('read-only mode denies writes and scope refuses outside project roots',()=>{
  assert.equal(permissionPolicy({scope:'read-only',webAccess:false}).sandbox,'read-only');
  assert.equal(approvalWithinScope({method:'item/fileChange/requestApproval',params:{grantRoot:resolve('elsewhere')}},{cwd:resolve('project'),scope:'project',webAccess:true}),false);
});
test('engine child receives required runtime environment but unrelated secrets are dropped',()=>{
  const env=isolatedEnvironment({PATH:'runtime',SystemRoot:'C:/Windows',HOME:'/tmp/home',AWS_SECRET_ACCESS_KEY:'secret',OPENAI_API_KEY:'secret',SUDO_CLI_MODEL:'model',ENGINE_SCENARIO:'test'},{CODEX_HOME:'/private',SUDO_CLI_SESSION_KEY:'bridge'});
  assert.equal(env.AWS_SECRET_ACCESS_KEY,undefined);assert.equal(env.OPENAI_API_KEY,undefined);
  assert.equal(env.PATH,'runtime');assert.equal(env.CODEX_HOME,'/private');assert.equal(env.SUDO_CLI_SESSION_KEY,'bridge');
});
