"""Observe the actual input question; record only identity and phase booleans."""
import json

def install_question_fixture(root, env):
    questions = root/'private-questions.jsonl'
    questions.write_text('')
    observer = root/'private-question-observer.mjs'
    observer.write_text('import readline from "node:readline/promises";import{stripVTControlCharacters}from"node:util";import{syncBuiltinESMExports}from"node:module";import{appendFileSync}from"node:fs";let serial=0;const create=readline.createInterface;readline.createInterface=function(...args){const value=create(...args),question=value.question;value.question=function(prompt,...options){const id=++serial;const submission=/\\d{2}:\\d{2} \\d+@you > /.test(stripVTControlCharacters(String(prompt)));const record=phase=>appendFileSync('+json.dumps(str(questions))+',JSON.stringify({id,submission,phase})+"\\n");record("waiting");return question.call(value,prompt,...options).then(answer=>{record("done");return answer;},error=>{record("done");throw error;});};return value;};syncBuiltinESMExports();\n')
    env['NODE_OPTIONS'] += ' --import '+observer.resolve().as_uri()
    return questions

def active_submission_question(path):
    records = [json.loads(row) for row in path.read_text().splitlines()]
    if not records:
        return False
    identity = max(row['id'] for row in records)
    last = next(row for row in reversed(records) if row['id'] == identity)
    return last['submission'] and last['phase'] == 'waiting'
