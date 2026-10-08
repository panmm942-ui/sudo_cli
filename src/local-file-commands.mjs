import {resolve} from 'node:path';
import {inspectLocalModel,importLocalModel} from './local-model-files.mjs';
import {validateConnection} from './runtime.mjs';

/** File selection is explicit user input; file contents never choose executable commands. */
export function createLocalFileCommands({cwd,settings,ask,note,profiles,reconnect,runOperation,
  inspect=inspectLocalModel,importModel=importLocalModel}){
  async function handle({name,args=[]}){
    if(name!=='/local'||!['file','info','inspect'].includes(args[0]))return false;
    const path=args.slice(1).join(' ')||await ask('  Local model file or folder path › ');
    if(!path)return true;
    const model=await runOperation('Inspecting local model',signal=>inspect(resolve(cwd,path),{signal}));
    note(`Local model: ${model.label}\nFile: ${model.path}\nSize: ${Number.isFinite(model.bytes)?(model.bytes/1024/1024).toFixed(1)+' MiB':'unknown'}`);
    if(model.reason)note(model.reason);for(const requirement of model.requirements||[])note(requirement);
    const runners=model.supportedRunners||[];
    if(args[0]!=='file')return true;
    if(!runners.length){note('This format needs a compatible model runner. No file was executed or uploaded. Start its compatible server, then use /local. See docs/local-model-files.md for format guidance.');return true;}
    const choices=runners.map((runner,index)=>`${index+1} ${runner==='ollama'?'Ollama':'LM Studio'}`).join(' / ');
    const choice=await ask(`  Load model [${choices} / 0 Inspect only] › `);
    if(!choice||choice==='0'){note('Inspected only. Your file was left in place.');return true;}
    const runner=runners[Number(choice)-1];if(!runner)throw new Error('Choose a listed runner or 0 to inspect only.');
    const modelName=runner==='ollama'?(await ask('  Local model name [my-local-ai] › '))||'my-local-ai':undefined;
    note(runner==='ollama'?'Ollama must be installed and its local server running. Import creates a local model entry and may use additional disk space.':'LM Studio CLI must be installed. Import copies the model; its original file stays in place. Load the imported model and start its local server afterward.');
    if(settings.permissions!=='allow-everything'&&!/^y(es)?$/i.test(await ask('  Import this model locally? [y/N] › '))){note('Import cancelled.');return true;}
    const imported=await runOperation('Importing local model',signal=>importModel({model,runner,name:modelName,signal,onOutput:text=>note(text)}));
    note('Local model import completed.');for(const instruction of imported.instructions||[])note(instruction);
    if(!imported.connection){note('After loading the model and starting its server, enter /local to connect.');return true;}
    let selected=imported.connection;
    const capacity=await ask('  Model context capacity [tokens; Enter if unknown] › ');
    if(capacity)selected={...selected,contextWindow:Number(capacity)};
    selected=validateConnection(selected);
    const profileName=(await ask(`  Save AI as [${selected.model}] › `))||selected.model.slice(0,100);
    await profiles.save({...selected,name:profileName});await reconnect(selected,{carryHistory:true});
    note(`Saved local AI: ${profileName}. Send a task to confirm model execution.`);return true;
  }
  return {handle};
}
