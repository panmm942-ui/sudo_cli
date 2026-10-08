import test from 'node:test';
import assert from 'node:assert/strict';
import {listMicrophoneDevices} from '../src/voice-devices.mjs';
test('audio discovery lists devices without selecting or recording one',async()=>{
  for(const platform of ['win32','linux','darwin']){let requested;const text=await listMicrophoneDevices({platform,execute:async(file,args)=>{requested={file,args};return 'Microphone 1';}});assert.match(text,/Microphone 1/);assert.match(text,/does not record/);assert.ok(!requested.args.includes('pipe:1'));if(platform!=='linux')assert.ok(requested.args.includes('-list_devices'));}
});
