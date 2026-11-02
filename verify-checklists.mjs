import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import {createSchema,withDb,setSetting,run,get,tx} from './server/db.js';
import {createCleaning,syncOpenChecklists} from './server/cleanings.js';
const db=new DatabaseSync(':memory:');createSchema(db);
withDb(db,()=>{
setSetting('templates',{regular:[{section:'Room',items:['Keep','Remove']}],general:[]});
const ids=['assigned','accepted','in_progress','done','cancelled'].map(status=>{const c=createCleaning({date:'2026-11-03'});run('UPDATE cleanings SET status=? WHERE id=?',status,c.id);return c.id});
const old=get('SELECT * FROM checklist_items WHERE cleaning_id=? AND text=?',ids[2],'Keep');run('UPDATE checklist_items SET done=1 WHERE id=?',old.id);
tx(()=>{setSetting('templates',{regular:[{section:'Room',items:['New','Keep']}],general:[]});syncOpenChecklists()});
for(const id of ids.slice(0,3))assert.equal(get('SELECT count(*) n FROM checklist_items WHERE cleaning_id=? AND text=?',id,'New').n,1);
assert.equal(get('SELECT done FROM checklist_items WHERE id=?',old.id).done,1);
for(const id of ids.slice(3))assert.equal(get('SELECT count(*) n FROM checklist_items WHERE cleaning_id=? AND text=?',id,'Remove').n,1);
setSetting('templates',{regular:[{section:'Room',items:[{text:'Keep',photo:true}]}],general:[]});tx(syncOpenChecklists);assert.equal(get('SELECT done FROM checklist_items WHERE id=?',old.id).done,0);
assert.equal(createCleaning({date:'2026-11-04'}).status,'unassigned');
console.log('Checklist synchronization checks passed');
});db.close();
