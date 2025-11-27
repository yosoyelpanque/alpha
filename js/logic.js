/* * logic.js
 * Lógica central de negocio: Login, Acciones de Inventario, 
 * Usuarios, Reportes, Croquis y Conciliación.
 */

import { 
    state, verifiers, saveState, logActivity, updateSerialNumberCache, 
    recalculateLocationCounts, photoDB, setState
} from './state.js';

import { 
    elements, showToast, showConfirmationModal, showUndoToast,
    renderDashboard, renderInventoryTable, renderUserList, 
    renderAdicionalesList, renderLoadedLists, renderDirectory,
    populateAreaSelects, populateReportFilters, escapeHTML,
    createInventoryRowElement
} from './ui.js';

import { exportSession } from './files.js';

// --- Variables Globales del Módulo ---
let html5QrCode;
let activeLayoutUrls = [];

// --- Utilidades Generales ---

function getLocalDate() {
    const date = new Date();
    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0'); 
    const year = date.getFullYear();
    return `${day}/${month}/${year}`;
}

function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

// --- Lógica de Sesión y Usuarios ---

export function handleEmployeeLogin() {
    const employeeNumber = elements.employeeNumberInput.value;
    const employeeName = verifiers[employeeNumber];
    
    if (employeeName) {
        const newCurrentUser = { number: employeeNumber, name: employeeName };

        if (state.loggedIn && state.currentUser && state.currentUser.number !== newCurrentUser.number) {
             showConfirmationModal(
                'Cambio de Usuario',
                `Actualmente hay un inventario en progreso. ¿Deseas continuar con el inventario actual como ${employeeName} o iniciar uno nuevo?`,
                () => {
                    logActivity('Cambio de usuario', `Sesión continuada por ${employeeName}.`);
                    state.currentUser = newCurrentUser;
                    showToast(`Bienvenido de nuevo, ${employeeName}. Continuando con la sesión actual.`);
                    saveState();
                    window.location.reload(); // Recargar para actualizar UI
                },
                { 
                    confirmText: 'Continuar', 
                    cancelText: 'Iniciar Nuevo',
                    onCancel: () => {
                         state.currentUser = newCurrentUser;
                         // El reset se maneja limpiando DB y recargando en un flujo real,
                         // o llamando a una función de reset. Por simplicidad aquí:
                         localStorage.removeItem('inventarioProState');
                         window.location.reload();
                    }
                }
            );
        } else {
            state.loggedIn = true;
            state.currentUser = newCurrentUser;
            if (!state.sessionStartTime) {
                state.sessionStartTime = new Date().toISOString();
                logActivity('Inicio de sesión', `Usuario ${employeeName} ha iniciado sesión.`);
            } else {
                logActivity('Reanudación de sesión', `Usuario ${employeeName} ha reanudado la sesión.`);
            }
            showToast(`Bienvenido, ${employeeName}`);
            saveState();
            // La UI se actualiza en el init de app.js al detectar login
            document.getElementById('login-page').classList.add('hidden');
            document.getElementById('main-app').classList.remove('hidden');
            
            // Actualizar display inmediatamente
            elements.currentUserDisplay.textContent = state.currentUser.name;
            elements.settings.summaryAuthor.value = state.currentUser.name;
        }

    } else {
        showToast('Este sistema solo puede ser utilizado por personal autorizado.', 'error');
    }
    elements.employeeNumberInput.value = '';
}

export function deleteListAndRefresh(listId) {
    const listToDelete = state.inventory.find(i => i.listId === listId);
    if (!listToDelete) return;

    logActivity('Listado eliminado', `Archivo: ${listToDelete.fileName}, Área: ${listToDelete.areaOriginal}`);
    state.inventory = state.inventory.filter(item => item.listId !== listId);
    showToast(`Listado "${listToDelete.fileName}" eliminado.`);
    updateSerialNumberCache();
    saveState();
    
    // Actualizar UI
    renderDashboard();
    populateAreaSelects();
    populateReportFilters();
    renderInventoryTable(state.inventory, 1, 50);
    renderLoadedLists();
}

// --- Acciones de Inventario ---

export function assignItem(item, user) {
    // 1. Obtener la ubicación precisa
    const selectDesktop = document.getElementById('active-user-location-select');
    const preciseLocation = selectDesktop ? selectDesktop.value : (user.locationWithId || 'N/A');

    // 2. Asignar datos
    item.UBICADO = 'SI';
    item['NOMBRE DE USUARIO'] = user.name;
    item.fechaUbicado = new Date().toISOString();
    item.areaIncorrecta = item.areaOriginal !== user.area;
    item.ubicacionEspecifica = preciseLocation; 
    
    logActivity('Bien Ubicado', `Clave: ${item['CLAVE UNICA']} anclado a: ${preciseLocation}`);

    checkAreaCompletion(item.areaOriginal);
    checkInventoryCompletion();
}

export function handleInventoryActions(action, selectedClaves) {
    if (state.readOnlyMode) return showToast('Modo de solo lectura.', 'warning');
    if (selectedClaves.length === 0) return showToast('Seleccione al menos un bien.', 'error');
    
    if (action === 'desubicar') {
        showConfirmationModal('Des-ubicar Bienes', `¿Marcar ${selectedClaves.length} bien(es) como NO ubicados?`, () => {
            selectedClaves.forEach(clave => {
                const item = state.inventory.find(i => i['CLAVE UNICA'] === clave);
                if (item) {
                    item.UBICADO = 'NO';
                    item['NOMBRE DE USUARIO'] = '';
                    item['IMPRIMIR ETIQUETA'] = 'NO'; 
                    item.fechaUbicado = null;
                    item.areaIncorrecta = false;
                    logActivity('Bien des-ubicado', `Clave: ${clave}`);
                    checkAreaCompletion(item.areaOriginal); 
                }
            });
            showToast(`${selectedClaves.length} bien(es) des-ubicado(s).`);
            saveState(); renderDashboard();
            // El render de tabla se debe llamar desde la UI o trigger events
            document.dispatchEvent(new CustomEvent('inventoryUpdated'));
        });
        return; 
    }

    if (!state.activeResguardante) {
        return showToast('Debe activar un usuario para realizar esta acción.', 'error');
    }
    const activeUser = state.activeResguardante;

    selectedClaves.forEach(clave => {
        const item = state.inventory.find(i => i['CLAVE UNICA'] === clave);
        if (!item) return;

        const isAssignedToOther = item.UBICADO === 'SI' && item['NOMBRE DE USUARIO'] && item['NOMBRE DE USUARIO'] !== activeUser.name;
        
        const processItem = () => {
            assignItem(item, activeUser); 
            
            if (action === 're-etiquetar') {
                item['IMPRIMIR ETIQUETA'] = 'SI';
                logActivity('Bien marcado para re-etiquetar', `Clave: ${clave}, Usuario: ${activeUser.name}`);
            } else if (action === 'ubicar') {
                if (item['IMPRIMIR ETIQUETA'] === 'SI') {
                    item['IMPRIMIR ETIQUETA'] = 'NO';
                    logActivity('Marca de re-etiquetar quitada', `Clave: ${clave}`);
                }
            }
        };

        if (isAssignedToOther) {
            showConfirmationModal('Reasignar Bien', `El bien ${clave} ya está asignado a ${item['NOMBRE DE USUARIO']}. ¿Reasignar a ${activeUser.name}?`, () => {
                logActivity('Bien reasignado', `Clave: ${clave} de ${item['NOMBRE DE USUARIO']} a ${activeUser.name}`);
                processItem();
                showToast(`Bien ${clave} reasignado.`);
                saveState(); renderDashboard();
                document.dispatchEvent(new CustomEvent('inventoryUpdated'));
            });
        } else {
            processItem(); 
        }
    });

    // Feedback general si no hubo modales
    const requiresConfirmation = selectedClaves.some(clave => {
         const item = state.inventory.find(i => i['CLAVE UNICA'] === clave);
         return item && item.UBICADO === 'SI' && item['NOMBRE DE USUARIO'] && item['NOMBRE DE USUARIO'] !== activeUser.name;
    });

    if (!requiresConfirmation) {
         const message = action === 'ubicar' ? `Se ubicaron ${selectedClaves.length} bienes.` : `Se marcaron ${selectedClaves.length} bienes para re-etiquetar.`;
         showToast(message);
         saveState(); renderDashboard();
         document.dispatchEvent(new CustomEvent('inventoryUpdated'));
    }
}

export function checkInventoryCompletion() {
    if (state.inventoryFinished || state.inventory.length === 0) return;

    const allLocated = state.inventory.every(item => item.UBICADO === 'SI');
    if (allLocated) {
        state.inventoryFinished = true;
        logActivity('Inventario completado', 'Todos los bienes han sido ubicados.');
        showConfirmationModal(
            '¡Inventario Completado!',
            'Has ubicado todos los bienes. ¿Generar Resumen de Sesión?',
            () => { 
                // Disparar evento para abrir modal de resumen
                document.dispatchEvent(new CustomEvent('openPreprint', { detail: { type: 'session_summary' } }));
            }
        );
        saveState();
    }
}

export function checkAreaCompletion(areaId) {
    if (!areaId || state.closedAreas[areaId]) return; 

    const areaItems = state.inventory.filter(item => item.areaOriginal === areaId);
    const isAreaComplete = areaItems.length > 0 && areaItems.every(item => item.UBICADO === 'SI');
    const wasPreviouslyComplete = !!state.completedAreas[areaId];

    if (isAreaComplete && !wasPreviouslyComplete) {
        state.completedAreas[areaId] = true; 
        logActivity('Área completada', `Área ${areaId} completada.`);
        showToast(`¡Área ${state.areaNames[areaId] || areaId} completada!`);
        saveState(); 
        renderLoadedLists(); 
    } else if (!isAreaComplete && wasPreviouslyComplete) {
        delete state.completedAreas[areaId];
        saveState();
        renderLoadedLists(); 
    }
}

// --- QR Scanner Logic ---

export async function startQrScanner() {
    if (state.readOnlyMode) return;
    elements.qrScannerModal.classList.add('show');
    
    if (html5QrCode && html5QrCode.isScanning) {
        await html5QrCode.stop();
    }
    html5QrCode = new Html5Qrcode("qr-reader");

    const config = { fps: 10, qrbox: { width: 250, height: 250 } };
    
    html5QrCode.start(
        { facingMode: "environment" }, 
        config,
        (decodedText) => {
            stopQrScanner();
            // Disparar evento de búsqueda
            const searchInput = elements.inventory.searchInput;
            searchInput.value = decodedText;
            searchInput.dispatchEvent(new Event('input'));
            
            // Cambiar a tab inventario
            document.querySelector('[data-tab="inventory"]').click();
            
            showToast(`Clave ${decodedText} escaneada.`);
            logActivity('Escaneo QR', `Clave: ${decodedText}.`);
        }
    ).catch(err => {
        showToast('Error al iniciar cámara.', 'error');
        console.error("QR Error: ", err);
        stopQrScanner();
    });
}

export function stopQrScanner() {
    if (html5QrCode && html5QrCode.isScanning) {
        html5QrCode.stop().then(() => {
            elements.qrScannerModal.classList.remove('show');
        }).catch(() => {
            elements.qrScannerModal.classList.remove('show');
        });
    } else {
        elements.qrScannerModal.classList.remove('show');
    }
}

// --- Layout (Croquis) Logic ---

export function getAreaColor(areaId) {
    if (!state.layoutItemColors[areaId]) {
        let hash = 0;
        for (let i = 0; i < String(areaId).length; i++) {
            hash = String(areaId).charCodeAt(i) + ((hash << 5) - hash);
        }
        const h = hash % 360; 
        const s = 70 + (hash % 20); 
        const l = 55 + (hash % 10); 
        state.layoutItemColors[areaId] = `hsl(${h}, ${s}%, ${l}%)`;
        saveState(); 
    }
    return state.layoutItemColors[areaId];
}

export function getLocationIcon(locationBase) {
    const base = String(locationBase).toUpperCase();
    if (base.includes('OFICINA')) return 'fa-solid fa-building';
    if (base.includes('CUBICULO') || base.includes('CUBÍCULO')) return 'fa-solid fa-user';
    if (base.includes('BODEGA')) return 'fa-solid fa-box-archive';
    if (base.includes('PASILLO')) return 'fa-solid fa-road';
    if (base.includes('SALA DE JUNTAS')) return 'fa-solid fa-users';
    if (base.includes('SECRETARIAL')) return 'fa-solid fa-keyboard';
    if (base.includes('FOTOCOPIADO')) return 'fa-solid fa-print';
    return 'fa-solid fa-location-dot'; 
}

export function populateLayoutSidebar() {
    const container = elements.layoutEditor.sidebar;
    container.innerHTML = '';
    const locationsMap = new Map();

    state.resguardantes.forEach(user => {
        const userLocations = (user.locations && user.locations.length > 0) 
                              ? user.locations 
                              : [user.locationWithId || 'Sin Ubicación'];

        userLocations.forEach(locId => {
            if (!locId) return;
            if (!locationsMap.has(locId)) {
                const baseMatch = locId.match(/^(.*)\s\d+$/);
                const locationBase = baseMatch ? baseMatch[1] : locId;
                locationsMap.set(locId, { locationBase, areaId: user.area, users: [] });
            }
            locationsMap.get(locId).users.push(user.name);
        });
    });

    const itemsOnCurrentPage = state.mapLayout[state.currentLayoutPage] || {};
    const sortedLocations = Array.from(locationsMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

    sortedLocations.forEach(([locId, data]) => {
        const el = document.createElement('div');
        el.className = 'layout-shape draggable-item';
        el.dataset.locationId = locId;
        el.dataset.areaId = data.areaId; 
        
        if (itemsOnCurrentPage[locId]) el.classList.add('hidden'); 
        
        const maxUsersToShow = 3;
        let usersHtml = data.users.slice(0, maxUsersToShow).map(name => `<li>${name}</li>`).join('');
        if (data.users.length > maxUsersToShow) usersHtml += `<li><em class="text-xs text-gray-500">+ ${data.users.length - maxUsersToShow} más...</em></li>`;

        const iconClass = getLocationIcon(data.locationBase);
        const areaColor = getAreaColor(data.areaId);
        
        el.innerHTML = `
            <div class="area-color-dot" style="background-color: ${areaColor};"></div>
            <h5><i class="${iconClass} location-icon"></i>${locId}</h5>
            <ul>${usersHtml}</ul>
        `;
        container.appendChild(el);
    });

    if (sortedLocations.length === 0) {
        container.innerHTML = '<p class="text-xs text-gray-400 text-center p-4">No hay ubicaciones registradas.</p>';
    }
}

export function createShapeOnCanvas(id, x, y, width, height, type = 'location', text = '', imageDataUrl = null, rotation = 0, areaId = null) {
    const canvas = elements.layoutEditor.canvas;
    if (canvas.querySelector(`[data-id="${id}"]`)) return;
    
    const el = document.createElement('div');
    el.className = 'layout-shape layout-on-canvas';
    el.dataset.id = id;
    
    let innerHtml = '';
    let colorDotHtml = ''; 

    if (type === 'location') {
        const user = state.resguardantes.find(u => u.locationWithId === id || (u.locations && u.locations.includes(id)));
        if (!user && !areaId) return; 

        const currentAreaId = areaId || user.area; 
        el.dataset.areaId = currentAreaId; 

        const usersInLoc = state.resguardantes
            .filter(u => (u.locations && u.locations.includes(id)) || u.locationWithId === id)
            .map(u => `<li>${u.name} (Área ${u.area})</li>`)
            .join('');
            
        const baseMatch = id.match(/^(.*)\s\d+$/);
        const iconClass = getLocationIcon(baseMatch ? baseMatch[1] : id);
        const areaColor = getAreaColor(currentAreaId);
        
        colorDotHtml = `<div class="area-color-dot" style="background-color: ${areaColor};"></div>`;
        innerHtml = `<h5><i class="${iconClass} location-icon"></i>${id}</h5><ul>${usersInLoc}</ul>`;
    } 
    else if (type === 'tool') {
        el.classList.add('tool-shape');
        innerHtml = `<i class="fa-solid fa-arrow-up tool-icon"></i>`;
        width = width || 50; height = height || 50;
    }
    else if (type === 'note') {
        el.classList.add('tool-note');
        innerHtml = `<textarea class="layout-shape-note-textarea" placeholder="Nota...">${text}</textarea>`;
        width = width || 200; height = height || 100;
    }
    else if (type === 'text') {
        el.classList.add('tool-text');
        innerHtml = `<textarea class="layout-shape-text-textarea" placeholder="Texto...">${text}</textarea>`;
        width = width || 150; height = height || 40;
    }
    else if (type === 'image') {
        el.classList.add('tool-image');
        if (imageDataUrl) el.style.backgroundImage = `url(${imageDataUrl})`;
        else innerHtml = `<span>Cargando...</span>`; 
        width = width || 300; height = height || 200;
    }

    el.style.transform = `translate(${x}px, ${y}px) rotate(${rotation}deg)`;
    if (width) el.style.width = `${width}px`;
    if (height) el.style.height = `${height}px`;
    
    el.dataset.x = x; el.dataset.y = y;
    el.dataset.rotation = rotation; el.dataset.type = type; 
    
    el.innerHTML = `${colorDotHtml}${innerHtml}
        <div class="layout-delete-btn" title="Eliminar"><i class="fa-solid fa-xmark"></i></div>
        <div class="layout-rotate-handle" title="Rotar"><i class="fa-solid fa-rotate-right"></i></div>`;
    
    canvas.appendChild(el);
    
    if (type === 'note' || type === 'text') { 
        el.querySelector('textarea').addEventListener('input', () => saveLayoutPositions());
    }
}

export function saveLayoutPositions() {
    const currentPageLayout = {};
    document.querySelectorAll('#layout-canvas .layout-on-canvas').forEach(el => {
        const id = el.dataset.id;
        const type = el.dataset.type;
        const itemData = {
            x: parseFloat(el.dataset.x) || 0,
            y: parseFloat(el.dataset.y) || 0,
            width: parseFloat(el.style.width) || 50,
            height: parseFloat(el.style.height) || 50,
            type,
            rotation: parseFloat(el.dataset.rotation) || 0
        };

        if (type === 'note' || type === 'text') itemData.text = el.querySelector('textarea').value;
        if (type === 'image') itemData.imageId = state.layoutImages[id];
        if (type === 'location') itemData.areaId = el.dataset.areaId;
        
        currentPageLayout[id] = itemData;
    });
    state.mapLayout[state.currentLayoutPage] = currentPageLayout;
}

export async function loadSavedLayout() {
    const canvas = elements.layoutEditor.canvas;
    canvas.innerHTML = ''; 
    
    if (activeLayoutUrls.length > 0) {
        activeLayoutUrls.forEach(url => URL.revokeObjectURL(url));
        activeLayoutUrls = [];
    }
    
    const layoutData = state.mapLayout[state.currentLayoutPage] || {};
    
    for (const id in layoutData) {
        const item = layoutData[id];
        let dataUrl = null;
        if (item.type === 'image' && item.imageId) {
            try {
                const blob = await photoDB.getItem('layoutImages', item.imageId);
                if (blob) {
                    dataUrl = URL.createObjectURL(blob);
                    activeLayoutUrls.push(dataUrl);
                }
            } catch(e) { console.error('Error loading layout img', e); }
        }
        createShapeOnCanvas(id, item.x, item.y, item.width, item.height, item.type, item.text, dataUrl, item.rotation, item.areaId);
    }
}

// --- Print Logic ---

export function preparePrint(activeTemplateId, options = {}) {
    const { date } = options;
    const dateToPrint = date || getLocalDate(); 
    
    document.querySelectorAll('.print-page').forEach(page => page.classList.remove('active'));

    const activeTemplate = document.getElementById(activeTemplateId);
    if (activeTemplate) {
        const dateElements = activeTemplate.querySelectorAll('.print-header-date');
        dateElements.forEach(el => el.textContent = el.id.includes('date') ? `Fecha: ${dateToPrint}` : dateToPrint);

        activeTemplate.classList.add('active');
        
        if (activeTemplateId === 'print-layout-view') {
            document.querySelectorAll('.print-page.layout-clone').forEach(clone => {
                clone.querySelector('.print-header-date').textContent = `Fecha: ${dateToPrint}`;
                clone.classList.add('active');
            });
        }
        
        window.print();
    } else {
        showToast('Error: Plantilla de impresión no encontrada.', 'error');
    }
}

// --- Conciliación (Comparación de Inventario) ---

export function runComparisonAlgorithm(newList) {
    const currentMap = new Map();
    state.inventory.forEach(item => currentMap.set(item['CLAVE UNICA'], item));

    const diff = { newItems: [], modItems: [], delItems: [] };
    const processedKeys = new Set();

    newList.forEach(newItem => {
        const clave = newItem['CLAVE UNICA'];
        processedKeys.add(clave);

        if (currentMap.has(clave)) {
            const currentItem = currentMap.get(clave);
            const modifications = [];
            const norm = (val) => String(val || '').trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, ' ');

            ['DESCRIPCION', 'MARCA', 'MODELO', 'SERIE'].forEach(field => {
                if (norm(currentItem[field]) !== norm(newItem[field])) {
                    modifications.push({ field, old: currentItem[field], new: newItem[field] });
                }
            });

            if (modifications.length > 0) {
                diff.modItems.push({ clave, newItem, modifications });
            }
        } else {
            diff.newItems.push(newItem);
        }
    });

    currentMap.forEach((item, clave) => {
        if (!processedKeys.has(clave)) diff.delItems.push(item);
    });

    renderReconciliationUI(diff);
}

function renderReconciliationUI(diff) {
    const modal = document.getElementById('reconciliation-modal');
    const container = document.getElementById('diff-content-container');
    
    document.getElementById('diff-count-new').textContent = diff.newItems.length;
    document.getElementById('diff-count-mod').textContent = diff.modItems.length;
    document.getElementById('diff-count-del').textContent = diff.delItems.length;

    // Renderizar Tabs (por defecto 'new')
    const renderTab = (type) => {
        container.innerHTML = '';
        let items = [];
        if (type === 'new') items = diff.newItems;
        if (type === 'mod') items = diff.modItems;
        if (type === 'del') items = diff.delItems;

        if (items.length === 0) return container.innerHTML = '<p class="text-center text-gray-500 p-4">Sin cambios.</p>';

        container.innerHTML = items.map(item => {
            const clave = item.clave || item['CLAVE UNICA'];
            let content = '';
            let colorClass = '';
            
            if (type === 'new') {
                colorClass = 'diff-new';
                content = `<p class="font-bold text-green-700">ALTA: ${clave}</p><p class="text-sm">${item['DESCRIPCION']}</p>`;
            } else if (type === 'mod') {
                colorClass = 'diff-mod';
                const modsHtml = item.modifications.map(m => 
                    `<div><span class="font-semibold text-xs">${m.field}:</span> <span class="diff-old-val">${m.old}</span> -> <span class="diff-new-val">${m.new}</span></div>`
                ).join('');
                content = `<p class="font-bold text-orange-700">CAMBIO: ${clave}</p><div class="pl-2 border-l-2 border-orange-200 mt-1">${modsHtml}</div>`;
            } else {
                colorClass = 'diff-del';
                content = `<p class="font-bold text-red-700">BAJA: ${clave}</p><p class="text-sm text-gray-600">${item['DESCRIPCION']}</p>`;
            }

            return `
                <div class="diff-card ${colorClass} flex items-center">
                    <input type="checkbox" class="mr-3 w-5 h-5 rounded diff-check" ${type !== 'del' ? 'checked' : ''} data-type="${type}" data-clave="${clave}">
                    <div>${content}</div>
                </div>`;
        }).join('');
    };

    renderTab('new'); // Init
    modal.classList.add('show');

    // Setup listeners locales para el modal
    document.getElementById('tab-diff-new').onclick = () => renderTab('new');
    document.getElementById('tab-diff-mod').onclick = () => renderTab('mod');
    document.getElementById('tab-diff-del').onclick = () => renderTab('del');
    
    const applyBtn = document.getElementById('reconciliation-apply-btn');
    // Clone para limpiar listeners viejos
    const newApplyBtn = applyBtn.cloneNode(true);
    applyBtn.parentNode.replaceChild(newApplyBtn, applyBtn);
    
    newApplyBtn.addEventListener('click', () => {
        const checks = document.querySelectorAll('.diff-check:checked');
        if (checks.length === 0) return showToast('Nada seleccionado.', 'warning');
        
        checks.forEach(cb => {
            const type = cb.dataset.type;
            const clave = cb.dataset.clave;
            
            if (type === 'new') {
                const newItem = diff.newItems.find(i => i['CLAVE UNICA'] === clave);
                if (newItem) {
                    newItem.UBICADO = 'NO'; newItem['IMPRIMIR ETIQUETA'] = 'NO'; newItem.listId = Date.now();
                    state.inventory.push(newItem);
                }
            } else if (type === 'mod') {
                const modData = diff.modItems.find(i => i.clave === clave);
                const target = state.inventory.find(i => i['CLAVE UNICA'] === clave);
                if (modData && target) {
                    target['DESCRIPCION'] = modData.newItem['DESCRIPCION'];
                    target['MARCA'] = modData.newItem['MARCA'];
                    target['MODELO'] = modData.newItem['MODELO'];
                    target['SERIE'] = modData.newItem['SERIE'];
                }
            } else if (type === 'del') {
                state.inventory = state.inventory.filter(i => i['CLAVE UNICA'] !== clave);
                delete state.photos[clave];
            }
        });
        
        showToast('Cambios aplicados.', 'success');
        saveState(); updateSerialNumberCache(); renderDashboard(); 
        renderInventoryTable(state.inventory, 1, 50);
        modal.classList.remove('show');
    });
}

// --- Impresión de Croquis ---

export async function printLayout() {
    logActivity('Impresión de Croquis', 'Generando impresión...');
    document.querySelectorAll('.print-page.layout-clone').forEach(el => el.remove());
    
    const masterTemplate = elements.printTemplates.layout;
    const userListContainer = masterTemplate.querySelector('#print-layout-user-list');
    
    const usersByArea = state.resguardantes.reduce((acc, user) => {
        const areaKey = user.area || 'Sin Área';
        if (!acc[areaKey]) acc[areaKey] = [];
        acc[areaKey].push(user);
        return acc;
    }, {});
    
    let userHtml = '<h2>Listado de Usuarios por Área</h2>';
    Object.keys(usersByArea).sort().forEach(area => {
        userHtml += `<h3>${state.areaNames[area] || `Área ${area}`}</h3><ul>` +
            usersByArea[area].map(u => `<li><strong>${u.name}</strong> (${(u.locations||[]).join(', ') || u.locationWithId})</li>`).join('') +
            '</ul>';
    });
    userListContainer.innerHTML = userHtml;

    const allPageKeys = Object.keys(state.layoutPageNames);
    const printDate = getLocalDate(); 

    for (let index = 0; index < allPageKeys.length; index++) {
        const pageKey = allPageKeys[index];
        const isFirstPage = index === 0;
        const pageTemplate = isFirstPage ? masterTemplate : masterTemplate.cloneNode(true);
        
        if (!isFirstPage) {
            pageTemplate.id = `print-layout-page-${index}`;
            pageTemplate.classList.add('layout-clone');
            pageTemplate.querySelector('#print-layout-user-list').innerHTML = '';
            elements.printContainer.appendChild(pageTemplate);
        }
        
        const pageName = state.layoutPageNames[pageKey] || pageKey;
        pageTemplate.querySelector('#print-layout-page-number').textContent = `Página ${index + 1}: ${pageName}`;
        pageTemplate.querySelector('#print-layout-date').textContent = `Fecha: ${printDate}`;

        const printCanvas = pageTemplate.querySelector('#print-layout-canvas');
        printCanvas.innerHTML = ''; 
        printCanvas.style.width = '100%'; printCanvas.style.height = '100%';
        
        const layoutData = state.mapLayout[pageKey] || {};
        for (const id in layoutData) {
            const item = layoutData[id];
            const el = document.createElement('div');
            el.className = 'layout-shape'; 
            el.style.position = 'absolute';
            el.style.left = `${item.x}px`; el.style.top = `${item.y}px`;
            el.style.width = `${item.width}px`; el.style.height = `${item.height}px`;
            el.style.transform = `rotate(${item.rotation || 0}deg)`;
            
            let innerHtml = '';
            if (item.type === 'location') {
                const baseMatch = id.match(/^(.*)\s\d+$/);
                const iconClass = getLocationIcon(baseMatch ? baseMatch[1] : id);
                const areaColor = getAreaColor(item.areaId || 'default');
                innerHtml = `<div class="area-color-dot" style="background-color:${areaColor}"></div><h5><i class="${iconClass}"></i>${id}</h5>`;
            } else if (item.type === 'tool') {
                innerHtml = `<i class="fa-solid fa-arrow-up tool-icon"></i>`;
                el.classList.add('tool-shape');
            } else if (item.type === 'note' || item.type === 'text') {
                el.classList.add(item.type === 'note' ? 'tool-note' : 'tool-text');
                innerHtml = `<textarea readonly>${item.text || ''}</textarea>`;
            } else if (item.type === 'image') {
                el.classList.add('tool-image');
                if(item.imageId) {
                    try {
                        const blob = await photoDB.getItem('layoutImages', item.imageId);
                        if(blob) el.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
                    } catch(e) {}
                }
            }
            el.innerHTML = innerHtml;
            printCanvas.appendChild(el);
        }
        pageTemplate.classList.add('active');
    }
    
    preparePrint('print-layout-view', { date: printDate });
}

// --- Impresión Masiva ---

export async function generateBatchReport() {
    const selectedCheckboxes = Array.from(document.querySelectorAll('.batch-user-checkbox:checked'));
    if (selectedCheckboxes.length === 0) return;

    const globalDate = elements.batchModal.dateInput.value;
    const globalEntrega = elements.batchModal.entregaInput.value;
    const globalCargo = elements.batchModal.cargoInput.value;
    const includeAdd = elements.batchModal.includeAdditionals.checked;
    const areaId = elements.reports.areaFilter.value;
    const areaName = state.areaNames[areaId];
    
    logActivity('Impresión Masiva', `Generando ${selectedCheckboxes.length} resguardos.`);
    showToast('Generando documentos...');

    const printContainer = document.getElementById('print-view-container');
    document.querySelectorAll('.print-page.batch-clone').forEach(el => el.remove());
    document.querySelectorAll('.print-page').forEach(page => page.classList.remove('active'));

    const masterTemplate = elements.printTemplates.resguardo;
    
    for (let i = 0; i < selectedCheckboxes.length; i++) {
        const userName = selectedCheckboxes[i].value;
        let items = state.inventory.filter(item => item['NOMBRE DE USUARIO'] === userName);
        if (includeAdd) {
            const adds = state.additionalItems.filter(item => item.usuario === userName);
            items = [...items, ...adds];
        }
        if (items.length === 0) continue;

        const pageClone = masterTemplate.cloneNode(true);
        pageClone.id = `batch-page-${i}`;
        pageClone.classList.add('batch-clone', 'active', 'batch-mode');
        
        // Llenar datos
        pageClone.querySelector('#print-resguardo-title').textContent = 'Resguardo Individual';
        pageClone.querySelector('#print-resguardo-area').textContent = areaName;
        pageClone.querySelector('.print-header-date').textContent = `Fecha: ${globalDate}`;
        pageClone.querySelector('#print-resguardo-author-name').textContent = globalEntrega;
        pageClone.querySelector('#print-resguardo-author-title').textContent = globalCargo;
        pageClone.querySelector('#print-resguardo-responsible-name').textContent = userName;
        
        const tbody = pageClone.querySelector('tbody');
        tbody.innerHTML = items.map(item => {
            const isAd = !!item.id;
            const clave = isAd ? (item.claveAsignada || item.clave) : item['CLAVE UNICA'];
            const desc = escapeHTML(item.descripcion || item.DESCRIPCION);
            return `<tr>
                <td class="col-num"></td>
                <td class="col-clave">${clave}</td>
                <td class="col-desc">${desc}</td>
                <td class="col-marca">${item.marca || item.MARCA}</td>
                <td class="col-modelo">${item.modelo || item.MODELO}</td>
                <td class="col-serie">${item.serie || item.SERIE}</td>
                <td class="col-area">${item.area || item.areaOriginal}</td>
                <td class="col-usuario">${userName}</td>
                <td class="col-status">${isAd ? 'Adicional' : 'Institucional'}</td>
            </tr>`;
        }).join('');
        
        if (i < selectedCheckboxes.length - 1) pageClone.classList.add('batch-page-break-after');
        printContainer.appendChild(pageClone);
    }

    elements.batchModal.modal.classList.remove('show');
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            setTimeout(() => window.print(), 1000); 
        });
    });
}