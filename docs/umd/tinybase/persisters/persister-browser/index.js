(function (global, factory) {
  typeof exports === 'object' && typeof module !== 'undefined'
    ? factory(exports)
    : typeof define === 'function' && define.amd
      ? define(['exports'], factory)
      : ((global =
          typeof globalThis !== 'undefined' ? globalThis : global || self),
        factory((global.TinyBasePersisterBrowser = {})));
})(this, function (exports) {
  'use strict';

  const UNDEFINED = '\uFFFC';

  const GLOBAL = globalThis;
  const WINDOW = GLOBAL.window;
  const isUndefined = (thing) => thing == void 0;
  const ifNotUndefined = (value, then, otherwise) =>
    isUndefined(value) ? otherwise?.() : then(value);
  const isArray = (thing) => Array.isArray(thing);
  const size = (arrayOrString) => arrayOrString.length;
  const errorNew = (message) => {
    throw new Error(message);
  };

  const arrayClear = (array, to) => array.splice(0, to);
  const arrayPush = (array, ...values) => array.push(...values);
  const arrayShift = (array) => array.shift();

  const object = Object;
  const getPrototypeOf = (obj) => object.getPrototypeOf(obj);
  const isObject = (obj) =>
    !isUndefined(obj) &&
    ifNotUndefined(
      getPrototypeOf(obj),
      (objPrototype) =>
        objPrototype == object.prototype ||
        isUndefined(getPrototypeOf(objPrototype)),

      /* istanbul ignore next */
      () => true,
    );
  const objIds = object.keys;
  const objFreeze = object.freeze;
  const objSize = (obj) => size(objIds(obj));
  const objIsEmpty = (obj) => isObject(obj) && objSize(obj) == 0;

  const jsonString = JSON.stringify;
  const jsonParse = JSON.parse;
  const jsonStringWithUndefined = (obj) =>
    jsonString(obj, (_key, value) => (value === void 0 ? UNDEFINED : value));
  const jsonParseWithUndefined = (str) =>
    jsonParse(str, (_key, value) => (value === UNDEFINED ? void 0 : value));

  const collHas = (coll, keyOrValue) => coll?.has(keyOrValue) ?? false;
  const collDel = (coll, keyOrValue) => coll?.delete(keyOrValue);

  const mapNew = (entries) => new Map(entries);
  const mapGet = (map, key) => map?.get(key);
  const mapSet = (map, key, value) =>
    isUndefined(value) ? (collDel(map, key), map) : map?.set(key, value);
  const mapEnsure = (map, key, getDefaultValue, hadExistingValue) => {
    if (!collHas(map, key)) {
      mapSet(map, key, getDefaultValue());
    }
    return mapGet(map, key);
  };

  const scheduleRunning = mapNew();
  const scheduleActions = mapNew();
  const getStoreFunctions = (persist = 1 /* StoreOnly */, store) =>
    persist != 1 /* StoreOnly */ && store.isMergeable()
      ? [
          1,
          store.getMergeableContent,
          store.getTransactionMergeableChanges,
          ([[changedTables], [changedValues]]) =>
            !objIsEmpty(changedTables) || !objIsEmpty(changedValues),
          store.setDefaultContent,
        ]
      : persist != 2 /* MergeableStoreOnly */
        ? [
            0,
            store.getContent,
            store.getTransactionChanges,
            ([changedTables, changedValues]) =>
              !objIsEmpty(changedTables) || !objIsEmpty(changedValues),
            store.setContent,
          ]
        : errorNew('Store type not supported by this Persister');
  const createCustomPersister = (
    store,
    getPersisted,
    setPersisted,
    addPersisterListener,
    delPersisterListener,
    onIgnoredError,
    persist,
    extra = {},
    scheduleId = [],
  ) => {
    let loadSave = 0;
    let loads = 0;
    let saves = 0;
    let action;
    let autoLoadHandle;
    let autoSaveListenerId;
    mapEnsure(scheduleRunning, scheduleId, () => 0);
    mapEnsure(scheduleActions, scheduleId, () => []);
    const [
      isMergeableStore,
      getContent,
      getChanges,
      hasChanges,
      setDefaultContent,
    ] = getStoreFunctions(persist, store);
    const run = async () => {
      /* istanbul ignore else */
      if (!mapGet(scheduleRunning, scheduleId)) {
        mapSet(scheduleRunning, scheduleId, 1);
        while (
          !isUndefined(
            (action = arrayShift(mapGet(scheduleActions, scheduleId))),
          )
        ) {
          try {
            await action();
          } catch (error) {
            /* istanbul ignore next */
            onIgnoredError?.(error);
          }
        }
        mapSet(scheduleRunning, scheduleId, 0);
      }
    };
    const setContentOrChanges = (contentOrChanges) => {
      (isMergeableStore && isArray(contentOrChanges?.[0])
        ? contentOrChanges?.[2] === 1
          ? store.applyMergeableChanges
          : store.setMergeableContent
        : contentOrChanges?.[2] === 1
          ? store.applyChanges
          : store.setContent)(contentOrChanges);
    };
    const load = async (initialContent) => {
      /* istanbul ignore else */
      if (loadSave != 2) {
        loadSave = 1;
        loads++;
        await schedule(async () => {
          try {
            const content = await getPersisted();
            if (isArray(content)) {
              setContentOrChanges(content);
            } else {
              errorNew(`Content is not an array ${content}`);
            }
          } catch (error) {
            onIgnoredError?.(error);
            if (initialContent) {
              setDefaultContent(initialContent);
            }
          }
          loadSave = 0;
        });
      }
      return persister;
    };
    const startAutoLoad = async (initialContent) => {
      await stopAutoLoad().load(initialContent);
      try {
        autoLoadHandle = await addPersisterListener(
          async (content, changes) => {
            if (changes || content) {
              /* istanbul ignore else */
              if (loadSave != 2) {
                loadSave = 1;
                loads++;
                setContentOrChanges(changes ?? content);
                loadSave = 0;
              }
            } else {
              await load();
            }
          },
        );
      } catch (error) {
        /* istanbul ignore next */
        onIgnoredError?.(error);
      }
      return persister;
    };
    const stopAutoLoad = () => {
      if (autoLoadHandle) {
        delPersisterListener(autoLoadHandle);
        autoLoadHandle = void 0;
      }
      return persister;
    };
    const isAutoLoading = () => !isUndefined(autoLoadHandle);
    const save = async (changes) => {
      /* istanbul ignore else */
      if (loadSave != 1) {
        loadSave = 2;
        saves++;
        await schedule(async () => {
          try {
            await setPersisted(getContent, changes);
          } catch (error) {
            /* istanbul ignore next */
            onIgnoredError?.(error);
          }
          loadSave = 0;
        });
      }
      return persister;
    };
    const startAutoSave = async () => {
      await stopAutoSave().save();
      autoSaveListenerId = store.addDidFinishTransactionListener(() => {
        const changes = getChanges();
        if (hasChanges(changes)) {
          save(changes);
        }
      });
      return persister;
    };
    const stopAutoSave = () => {
      ifNotUndefined(autoSaveListenerId, store.delListener);
      autoSaveListenerId = void 0;
      return persister;
    };
    const isAutoSaving = () => !isUndefined(autoSaveListenerId);
    const schedule = async (...actions) => {
      arrayPush(mapGet(scheduleActions, scheduleId), ...actions);
      await run();
      return persister;
    };
    const getStore = () => store;
    const destroy = () => {
      arrayClear(mapGet(scheduleActions, scheduleId));
      return stopAutoLoad().stopAutoSave();
    };
    const getStats = () => ({loads, saves});
    const persister = {
      load,
      startAutoLoad,
      stopAutoLoad,
      isAutoLoading,
      save,
      startAutoSave,
      stopAutoSave,
      isAutoSaving,
      schedule,
      getStore,
      destroy,
      getStats,
      ...extra,
    };
    return objFreeze(persister);
  };

  const STORAGE = 'storage';
  const createStoragePersister = (
    store,
    storageName,
    storage,
    onIgnoredError,
  ) => {
    const getPersisted = async () =>
      jsonParseWithUndefined(storage.getItem(storageName));
    const setPersisted = async (getContent) =>
      storage.setItem(storageName, jsonStringWithUndefined(getContent()));
    const addPersisterListener = (listener) => {
      const storageListener = (event) => {
        if (event.storageArea === storage && event.key === storageName) {
          try {
            listener(jsonParse(event.newValue));
          } catch {
            listener();
          }
        }
      };
      WINDOW.addEventListener(STORAGE, storageListener);
      return storageListener;
    };
    const delPersisterListener = (storageListener) =>
      WINDOW.removeEventListener(STORAGE, storageListener);
    return createCustomPersister(
      store,
      getPersisted,
      setPersisted,
      addPersisterListener,
      delPersisterListener,
      onIgnoredError,
      3,
      // StoreOrMergeableStore,
      {getStorageName: () => storageName},
    );
  };
  const createLocalPersister = (store, storageName, onIgnoredError) =>
    createStoragePersister(store, storageName, localStorage, onIgnoredError);
  const createSessionPersister = (store, storageName, onIgnoredError) =>
    createStoragePersister(store, storageName, sessionStorage, onIgnoredError);

  exports.createLocalPersister = createLocalPersister;
  exports.createSessionPersister = createSessionPersister;
});
