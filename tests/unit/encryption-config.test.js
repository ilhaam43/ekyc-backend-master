import {afterEach,expect,test,vi} from 'vitest';
import {Encryption} from '../../packages/shared/src/encryption.js';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
test('missing encryption service is explicitly unavailable before reading deployment keys',async()=>{
 vi.stubEnv('MASTER_ENCRYPTION_KEY','');vi.stubEnv('MASTER_ENCRYPTION_IV','');
 await expect(new Encryption({encryptionMock:true}).keys({encryption:{}})).rejects.toMatchObject({status:503,code:'ENCRYPTION_NOT_CONFIGURED'});
});
test('missing deployment keys are explicitly unavailable without calling the encryption service',async()=>{
 vi.stubEnv('MASTER_ENCRYPTION_KEY','');vi.stubEnv('MASTER_ENCRYPTION_IV','');const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
 await expect(new Encryption({encryptionUrl:'https://encryption.example.test'}).keys({encryption:{}})).rejects.toMatchObject({status:503,code:'ENCRYPTION_KEYS_NOT_CONFIGURED'});expect(fetch).not.toHaveBeenCalled();
});
test('configured encryption preserves the existing decrypt payload contract',async()=>{
 vi.stubEnv('MASTER_ENCRYPTION_KEY','synthetic-key');vi.stubEnv('MASTER_ENCRYPTION_IV','synthetic-iv');
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({success:true,data:{encryption_key:'tenant-key',iv:'tenant-iv'}})}));vi.stubGlobal('fetch',fetch);
 const encryption=new Encryption({encryptionUrl:'https://encryption.example.test'});expect(await encryption.keys({encryption:{ciphertext:'preserved'}})).toEqual({encryption_key:'tenant-key',iv:'tenant-iv'});
 expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({key:'synthetic-key',IV:'synthetic-iv',data:{ciphertext:'preserved'}});
});

test('unreadable mounted master secrets return an explicit configuration error', async () => {
 vi.stubEnv('MASTER_ENCRYPTION_KEY_FILE', 'missing-test-secret-file-that-does-not-exist'); vi.stubEnv('MASTER_ENCRYPTION_IV_FILE', '');
 await expect(new Encryption({encryptionUrl:'https://encryption.example.test'}).keys({encryption:{}})).rejects.toMatchObject({status:503,code:'ENCRYPTION_KEYS_NOT_CONFIGURED'});
});
