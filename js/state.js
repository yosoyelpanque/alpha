/* * state.js
 * Manejo del estado global, persistencia en LocalStorage 
 * y base de datos de imágenes en IndexedDB.
 */

// Verificadores autorizados (Base de datos estática de empleados)
export const verifiers = {
    '41290': 'BENÍTEZ HERNÁNDEZ MARIO',
    '41292': 'ESCAMILLA VILLEGAS BRYAN ANTONY',
    '41282': 'LÓPEZ QUINTANA ALDO',
    '41287': 'MARIN ESPINOSA MIGUEL',
    '41289': 'SANCHEZ ARELLANES RICARDO',
    '41293': 'EDSON OSNAR TORRES JIMENEZ',
    '15990': 'CHÁVEZ SÁNCHEZ ALFONSO',
    '17326': 'DOMÍNGUEZ VAZQUEZ FRANCISCO JAVIER',
    '11885': 'ESTRADA HERNÁNDEZ ROBERTO',
    '19328': 'LÓPEZ ESTRADA LEOPOLDO',
    '44925': 'MENDOZA SOLARES JOSE JUAN',
    '16990': 'PÉREZ RODRÍGUEZ DANIEL',
    '16000': 'PÉREZ YAÑEZ JUAN JOSE',
    '17812': 'RODRÍGUEZ RAMÍREZ RENE',
    '44095': 'LOPEZ JIMENEZ ALAN GABRIEL',
    '2875': 'VIZCAINO ROJAS ALVARO'
};

// Estado Inicial por defecto
export const defaultState = {
    inventoryEditMode: false,
    loggedIn: false, 
    currentUser: null, 
    inventory: [], 
    additionalItems: [],
    resguardantes: [], 
    activeResguardante: null, 
    locations: {}, 
    areas: [], 
    areaNames: {},
    lastAutosave: null, 
    sessionStartTime: null, 
    additionalPhotos: {}, 
    locationPhotos: {},
    notes: {}, 
    photos: {}, 
    theme: 'light',
    inventoryFinished: false,
    areaDirectory: {},
    closedAreas: {},
    completedAreas: {}, 
    persistentAreas: [],
    serialNumberCache: new Set(),
    cameraStream: null,
    readOnlyMode: false,
    activityLog: [],
    institutionalReportCheckboxes: {},
    actionCheckboxes: {
        labels: {},
        notes: {},
        additional: {},
        mismatched: {},
        personal: {}
    },
    reportCheckboxes: {
        notes: {},
        mismatched: {}
    },
    mapLayout: { 'page1': {} }, 
    currentLayoutPage: 'page1',
    layoutPageNames: { 'page1': 'Página 1' },
    layoutImages: {},
    layoutPageColors: { 'page1': '#ffffff' }, 
    layoutItemColors: {} 
};

// Estado Reactivo (Mutable)
export let state = JSON.parse(JSON.stringify(defaultState));

// Función para actualizar el estado completamente (útil para reset y carga)
export function setState(newState) {
    state = newState;
    // Recuperar el Set de caché que no se guarda en JSON
    updateSerialNumberCache();
}

// Generador de IDs únicos
export function generateUUID() {
    if (crypto && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Sistema de Base de Datos para Fotos (IndexedDB)
export const photoDB = {
    db: null,
    init: function() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open('InventarioProPhotosDB', 2); 
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
                if (!db.objectStoreNames.contains('layoutImages')) db.createObjectStore('layoutImages');
            };
            request.onsuccess = (event) => { this.db = event.target.result; resolve(); };
            request.onerror = (event) => { console.error('Error con IndexedDB:', event.target.errorCode); reject(event.target.errorCode); };
        });
    },
    setItem: function(storeName, key, value) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            const transaction = this.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(value, key);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    },
    getItem: function(storeName, key) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
    },
    deleteItem: function(storeName, key) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            const transaction = this.db.transaction([storeName], 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.delete(key);
            request.onsuccess = () => resolve();
            request.onerror = (event) => reject(event.target.error);
        });
    },
    getAllItems: function(storeName) {
        return new Promise((resolve, reject) => {
            if (!this.db) return reject('DB not initialized');
            const transaction = this.db.transaction([storeName], 'readonly');
            const store = transaction.objectStore(storeName);
            const keysRequest = store.getAllKeys();
            const valuesRequest = store.getAll();

            Promise.all([
                new Promise((res, rej) => { keysRequest.onsuccess = () => res(keysRequest.result); keysRequest.onerror = (e) => rej(e.target.error); }),
                new Promise((res, rej) => { valuesRequest.onsuccess = () => res(valuesRequest.result); valuesRequest.onerror = (e) => rej(e.target.error); })
            ]).then(([keys, values]) => {
                const result = keys.map((key, index) => ({ key, value: values[index] }));
                resolve(result);
            }).catch(reject);
        });
    },
    close: function() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
};

export function deleteDB(dbName) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(dbName);
        request.onsuccess = () => resolve();
        request.onerror = (event) => reject(event.target.error);
        request.onblocked = () => {
            console.warn('La eliminación de IndexedDB fue bloqueada.');
            resolve(); 
        };
    });
}

// Funciones auxiliares de Estado
export function updateSerialNumberCache() {
    if (!state.serialNumberCache) state.serialNumberCache = new Set();
    state.serialNumberCache.clear();
    state.inventory.forEach(item => {
        if (item.SERIE) state.serialNumberCache.add(String(item.SERIE).trim().toLowerCase());
        if (item['CLAVE UNICA']) state.serialNumberCache.add(String(item['CLAVE UNICA']).trim().toLowerCase());
    });
    state.additionalItems.forEach(item => {
        if (item.serie) state.serialNumberCache.add(String(item.serie).trim().toLowerCase());
        if (item.clave) state.serialNumberCache.add(String(item.clave).trim().toLowerCase());
    });
}

export function recalculateLocationCounts() {
    state.locations = {};
    state.resguardantes.forEach(user => {
        let locsToProcess = [];
        if (user.locations && Array.isArray(user.locations) && user.locations.length > 0) {
            locsToProcess = user.locations;
        } else if (user.locationWithId) {
            locsToProcess = [user.locationWithId];
        }

        locsToProcess.forEach(locFull => {
            if (!locFull) return;
            const baseMatch = locFull.match(/^(.*?)\s*(\d+)$/);
            let base;
            if (baseMatch) {
                base = baseMatch[1].trim().toUpperCase(); 
            } else {
                base = locFull.trim().toUpperCase();
            }
            state.locations[base] = (state.locations[base] || 0) + 1;
        });
    });
}

export function logActivity(action, details = '') {
    const timestamp = new Date().toLocaleString('es-MX');
    const logEntry = `[${timestamp}] ${action}: ${details}`;
    
    state.activityLog.push(logEntry);

    // Mantener log manejable
    if (state.activityLog.length > 500) {
        state.activityLog = state.activityLog.slice(-500); 
    }
}

export function loadState() {
    try {
        const storedState = localStorage.getItem('inventarioProState');
        if (storedState) {
            const loaded = JSON.parse(storedState);
            // Fusionar con defaultState para asegurar que nuevas propiedades existan
            state = { ...defaultState, ...state, ...loaded };
            
            // Migración de Layout antiguo
            if (!state.mapLayout || !state.mapLayout.page1) {
                 if (Object.keys(state.mapLayout || {}).length > 0 && !state.mapLayout.page1) {
                    const oldLayout = { ...state.mapLayout };
                    state.mapLayout = { 'page1': oldLayout };
                    state.currentLayoutPage = 'page1';
                    state.layoutPageNames = { 'page1': 'Página 1' };
                }
            }
            updateSerialNumberCache();
            return true;
        }
    } catch (e) { 
        console.error('Error al cargar el estado:', e);
        // Si falla, limpiamos para evitar bucles de error
        // localStorage.removeItem('inventarioProState'); // Opcional: Descomentar si se desea auto-fix drástico
    }
    return false;
}