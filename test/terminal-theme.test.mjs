import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {stripVTControlCharacters} from 'node:util';

test('live user prompts keep the same requested color as retained user text',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});
  await theme.set('txtcolor','red');
  for(const text of ['\x1b[92m  you › \x1b[0mhello','\x1b[38;5;46msearch\x1b[0m','\x1b[38;2;0;255;0mtyped']) {
    const live=theme.styleUserInput(text);
    assert.equal(stripVTControlCharacters(live),stripVTControlCharacters(text));
    assert.doesNotMatch(live,/38;2;0;255;0m|\x1b\[92m/);
    assert.match(live,/38;2;255;0;0m/);
  }
});

test('reset is accepted by both color commands and restores only the requested setting',async()=>{
  const {createTerminalTheme,DEFAULT_TERMINAL_COLORS}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});
  await theme.set('bgcolor','white');await theme.set('txtcolor','red');
  await theme.set('bgcolor','reset');
  assert.equal(theme.get().bgcolor,DEFAULT_TERMINAL_COLORS.bgcolor);assert.equal(theme.get().txtcolor,'#ff0000');
  await theme.set('txtcolor','reset');assert.equal(theme.get().txtcolor,DEFAULT_TERMINAL_COLORS.txtcolor);
});

test('saved lower-chat colors survive restart and reset independently',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const directory=await mkdtemp(join(tmpdir(),'sudo-theme-'));
  try {
    const theme=createTerminalTheme({directory,color:true,env:{TERM:'xterm'}});
    await theme.load();await theme.set('bgcolor','white');await theme.set('txtcolor','#114488');
    const restarted=createTerminalTheme({directory,color:true,env:{TERM:'xterm'}});await restarted.load();
    assert.equal(restarted.get().bgcolor,'#ffffff');assert.equal(restarted.get().txtcolor,'#114488');
    await restarted.reset('txtcolor');assert.equal(restarted.get().bgcolor,'#ffffff');assert.equal(restarted.get().txtcolor,'#00ff00');
    await restarted.reset('bgcolor');assert.equal(restarted.get().bgcolor,'#0b0f14');
    const record=JSON.parse(await readFile(join(directory,'terminal-theme.json'),'utf8'));
    assert.deepEqual(record,{version:1,bgcolor:'#0b0f14',txtcolor:'#00ff00'});
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('matching background and requested user color stay readable without discarding the requested color',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});
  await theme.set('bgcolor','#777777');await theme.set('txtcolor','#777777');
  assert.equal(theme.get().txtcolor,'#777777');assert.equal(theme.get().effectiveTxtcolor,'#000000');assert.equal(theme.get().adjusted,true);
  assert.ok(theme.get().contrast>=4.5);
  assert.match(theme.styleUserText('read this'),/\x1b\[38;2;0;0;0mread this/);
  await theme.set('bgcolor','black');await theme.set('txtcolor','white');
  assert.equal(theme.get().adjusted,false);assert.equal(theme.get().effectiveTxtcolor,'#ffffff');
});

test('invalid and control-sequence colors cannot replace the working saved theme',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});
  await theme.set('txtcolor','#ABCDEF');assert.equal(theme.get().txtcolor,'#abcdef');
  for(const value of ['unknown','#12345','#1234567','\x1b[31mred','red\n'])await assert.rejects(()=>theme.set('txtcolor',value),/color/i);
  assert.equal(theme.get().txtcolor,'#abcdef');
  await assert.rejects(()=>theme.set('header','white'),/target|setting/i);
});

test('body styles replace old dashboard backgrounds and repair unreadable accent foregrounds',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','white');
  const rendered=theme.styleBodyText('\x1b[92mready\x1b[0m\x1b[48;2;11;15;20m body');
  assert.equal(stripVTControlCharacters(rendered),'ready body');assert.doesNotMatch(rendered,/48;2;11;15;20/);
  assert.ok(rendered.startsWith(theme.bodyStyle));assert.ok(rendered.endsWith(theme.bodyStyle));
  assert.match(rendered,/38;2;0;0;0mready/);
});

test('disabled colors never introduce escapes and remove stored styling from text',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  for(const options of [{color:false,env:{}},{color:true,env:{NO_COLOR:'1'}},{color:true,env:{TERM:'dumb'}}]){
    const theme=createTerminalTheme(options);await theme.set('bgcolor','red');await theme.set('txtcolor','red');
    assert.equal(theme.backgroundStyle,'');assert.equal(theme.bodyStyle,'');assert.equal(theme.userStyle,'');
    assert.equal(theme.styleUserText('\x1b[31mhello\x1b[0m'),'hello');assert.equal(theme.styleBodyText('hello'),'hello');
  }
});

test('live user input preserves readline cursor controls and restores requested user foreground after prompt accents',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm'}});await theme.set('bgcolor','black');await theme.set('txtcolor','#abcdef');
  const rendered=theme.styleUserInput('\x1b[1G\x1b[0J\x1b[92m  you › \x1b[0mtyped\x1b[39m next');
  assert.ok(rendered.includes('\x1b[1G\x1b[0J'));
  assert.match(rendered,/\x1b\[38;2;171;205;239m  you › /);
  assert.match(rendered,/\x1b\[38;2;171;205;239mtyped/);
  assert.match(rendered,/\x1b\[38;2;171;205;239m next/);
  assert.ok(rendered.startsWith(theme.userStyle));assert.ok(rendered.endsWith(theme.userStyle));
});

test('NO_COLOR user input retains editing controls while removing foreground and background styling',async()=>{
  const {createTerminalTheme}=await import('../src/terminal-theme.mjs');
  const theme=createTerminalTheme({color:true,env:{TERM:'xterm',NO_COLOR:'1'}});
  assert.equal(theme.styleUserInput('\x1b[1G\x1b[0J\x1b[92mtyped\x1b[0m'),'\x1b[1G\x1b[0Jtyped');
  assert.equal(theme.styleBodyText('\x1b[1G\x1b[0J\x1b[92mquestion\x1b[0m'),'\x1b[1G\x1b[0Jquestion');
});
