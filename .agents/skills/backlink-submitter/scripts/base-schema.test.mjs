import assert from 'node:assert/strict';
import test from 'node:test';
import {baseFields, compareBaseSchema} from './base-schema.mjs';

test('standard fields allow cosmetic choices and project submitters',()=>{
 const fields=baseFields({defaultSubmitter:'example-owner'});
 fields.find(f=>f.name==='Submitter').options.push({name:'other-owner'});
 for(const field of fields){delete field.description;field.id=`field-${field.name}`;}
 const result=compareBaseSchema(fields,{defaultSubmitter:'example-owner'});
 assert.equal(result.ok,true);assert.equal(fields.length,16);assert.equal(result.warnings.length,16);
});

test('schema comparison rejects settings that change business meaning',()=>{
 for(const [name,change] of [
  ['status',f=>f.options.push({name:'obsolete'})],
  ['link_type',f=>f.options.pop()],
  ['category',f=>{f.multiple=true;}],
  ['Submitter',f=>{f.options=[];}],
  ['date',f=>{f.default_value='2026-01-01';}],
  ['月份',f=>{f.expression='NOW()';}],
  ['月份',f=>{f.expression=f.expression.replace('YYYY-MM','YYYY -MM');}],
  ['cost',f=>{f.style.currency_code='EUR';}],
  ['URL',f=>{f.style.type='plain';}],
 ]) {
  const fields=baseFields({defaultSubmitter:'example-owner'});change(fields.find(f=>f.name===name));
  const result=compareBaseSchema(fields,{defaultSubmitter:'example-owner'});
  assert.equal(result.ok,false,name);assert.ok(result.errors.some(e=>e.includes(name)),name);
 }
 const fields=baseFields();fields.push({name:'execution-log',type:'text'});
 assert.equal(compareBaseSchema(fields).ok,false);
});
