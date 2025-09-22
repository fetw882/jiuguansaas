// DB adapter: choose Postgres if configured, otherwise fallback to file DB
const usePg = !!(process.env.PG_URL || process.env.DATABASE_URL || process.env.PGHOST);

let impl;
try {
  if (usePg) {
    impl = await import('./pg.js');
  } else {
    impl = await import('./file.js');
  }
} catch (e) {
  impl = await import('./file.js');
}

export const upsertUser = impl.upsertUser;
export const getUserByEmail = impl.getUserByEmail;
export const getEntitlements = impl.getEntitlements;
export const setEntitlements = impl.setEntitlements;
export const getUserSettings = impl.getUserSettings;
export const saveUserSettings = impl.saveUserSettings;
export const listCharacters = impl.listCharacters;
export const saveCharacters = impl.saveCharacters;
export const addCharacter = impl.addCharacter;
export const getCharacterByAvatar = impl.getCharacterByAvatar;
export const listCharacterChats = impl.listCharacterChats;
export const saveCharacterChat = impl.saveCharacterChat;
export const getCharacterChat = impl.getCharacterChat;
export const deleteCharacterChat = impl.deleteCharacterChat;
export const listPresets = impl.listPresets;
export const savePreset = impl.savePreset;
export const getPreset = impl.getPreset;
export const deletePreset = impl.deletePreset;
export const getWorldInfo = impl.getWorldInfo;
export const saveWorldInfo = impl.saveWorldInfo;
export const listGroups = impl.listGroups;
export const saveGroups = impl.saveGroups;
export const addGroup = impl.addGroup;
export const getGroupById = impl.getGroupById;
export const deleteGroup = impl.deleteGroup;
export const getSecretState = impl.getSecretState;
export const writeSecretValue = impl.writeSecretValue;
export const findSecretValue = impl.findSecretValue;
export const deleteSecretValue = impl.deleteSecretValue;
export const rotateSecretValue = impl.rotateSecretValue;
export const renameSecretValue = impl.renameSecretValue;
