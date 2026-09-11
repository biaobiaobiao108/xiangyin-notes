import type { Note, Notebook, User } from "../shared/types";
import type { SyncMutation } from "../shared/sync";

const DATABASE_NAME = "xiangying-notes-offline";
const DATABASE_VERSION = 1;

export type OfflineConflict = {
  id: string;
  noteId: string;
  local: Note;
  server: Note;
  createdAt: number;
};

type MetaValue = {
  key: string;
  value: unknown;
};

type OfflineDatabase = IDBDatabase;

let databasePromise: Promise<OfflineDatabase | null> | null = null;

function isSupported() {
  return typeof indexedDB !== "undefined";
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

function openDatabase() {
  if (!isSupported()) return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<OfflineDatabase | null>((resolve) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("notes")) database.createObjectStore("notes", { keyPath: "id" });
      if (!database.objectStoreNames.contains("notebooks")) database.createObjectStore("notebooks", { keyPath: "id" });
      if (!database.objectStoreNames.contains("mutations")) {
        const store = database.createObjectStore("mutations", { keyPath: "operationId" });
        store.createIndex("entityId", "entityId", { unique: false });
      }
      if (!database.objectStoreNames.contains("conflicts")) {
        const store = database.createObjectStore("conflicts", { keyPath: "id" });
        store.createIndex("noteId", "noteId", { unique: false });
      }
      if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => resolve(null);
  });
  return databasePromise;
}

async function readAll<T>(storeName: string) {
  const database = await openDatabase();
  if (!database) return [] as T[];
  const transaction = database.transaction(storeName, "readonly");
  const completed = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore(storeName).getAll() as IDBRequest<T[]>);
  await completed;
  return result;
}

async function putValue(storeName: string, value: unknown) {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function deleteValue(storeName: string, key: IDBValidKey) {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(storeName, "readwrite");
  transaction.objectStore(storeName).delete(key);
  await transactionDone(transaction);
}

async function readMeta<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  if (!database) return undefined;
  const transaction = database.transaction("meta", "readonly");
  const completed = transactionDone(transaction);
  const result = await requestResult(transaction.objectStore("meta").get(key) as IDBRequest<MetaValue | undefined>);
  await completed;
  return result?.value as T | undefined;
}

export async function getOfflineUser() {
  return await readMeta<User>("user") ?? null;
}

export async function setOfflineUser(user: User) {
  const previous = await getOfflineUser();
  if (previous && previous.id !== user.id) await clearOfflineData();
  await putValue("meta", { key: "user", value: user });
}

export async function getSyncCursor() {
  return Number(await readMeta<number>("cursor") ?? 0);
}

export async function setSyncCursor(cursor: number) {
  await putValue("meta", { key: "cursor", value: cursor });
}

export async function getLocalSnapshot() {
  const [notes, notebooks, mutations, conflicts] = await Promise.all([
    readAll<Note>("notes"),
    readAll<Notebook>("notebooks"),
    readAll<SyncMutation>("mutations"),
    readAll<OfflineConflict>("conflicts"),
  ]);
  return { notes, notebooks, mutations, conflicts };
}

export async function putLocalNote(note: Note) {
  await putValue("notes", note);
}

export async function putLocalNotebook(notebook: Notebook) {
  await putValue("notebooks", notebook);
}

export async function deleteLocalNote(noteId: string) {
  await deleteValue("notes", noteId);
}

export async function deleteLocalNotebook(notebookId: string) {
  await deleteValue("notebooks", notebookId);
}

export async function putMutation(mutation: SyncMutation) {
  await putValue("mutations", mutation);
}

export async function getPendingMutations() {
  return await readAll<SyncMutation>("mutations");
}

export async function getOfflineConflicts() {
  return await readAll<OfflineConflict>("conflicts");
}

export async function deleteMutation(operationId: string) {
  await deleteValue("mutations", operationId);
}

export async function putConflict(conflict: OfflineConflict) {
  await putValue("conflicts", conflict);
}

export async function deleteConflict(conflictId: string) {
  await deleteValue("conflicts", conflictId);
}

export async function clearOfflineData() {
  const database = await openDatabase();
  if (!database) return;
  const transaction = database.transaction(["notes", "notebooks", "mutations", "conflicts", "meta"], "readwrite");
  for (const storeName of ["notes", "notebooks", "mutations", "conflicts", "meta"]) transaction.objectStore(storeName).clear();
  await transactionDone(transaction);
}
