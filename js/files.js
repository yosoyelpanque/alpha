/* * files.js
 * Manejo de importación/exportación de Excel (XLSX), 
 * Respaldos (ZIP) y procesamiento de archivos masivos.
 */

import { 
    state, 
    photoDB, 
    setState, 
    updateSerialNumberCache, 
    logActivity, 
    recalculateLocationCounts,
    saveState // Necesitamos guardar después de importar
} from './state.js';

import { 
    elements, 
    showToast, 
    showConfirmationModal, 
    renderDashboard, 
    populateAreaSelects, 
    populateReportFilters, 
    populateBookTypeFilter, 
    renderInventoryTable, 
    renderLoadedLists, 
    renderDirectory,
    renderUserList
} from './ui.js';

// --- Utilidades de Excel ---

// Detecta fechas en celdas de Excel (Texto o Número Serial)
function findReportDateSmart(sheet) {
    if (!sheet['!ref']) return 'S/F';
    
    const range = XLSX.utils.decode_range(sheet['!ref']);
    const maxRow = Math.min(range.e.r, 10); 
    const maxCol = Math.min(range.e.c, 30); 
    const dateRegex = /(\d{2})[\/\-](\d{2})[\/\-](\d{4})/;

    for (let R = 0; R <= maxRow; ++R) {
        for (let C = 0; C <= maxCol; ++C) {
            const cellRef = XLSX.utils.encode_cell({c: C, r: R});
            const cell = sheet[cellRef];

            if (!cell) continue;

            // Fecha como número serial de Excel
            if (cell.t === 'n' && cell.v > 43000 && cell.v < 60000) {
                try {
                    const dateObj = XLSX.SSF.parse_date_code(cell.v);
                    if (dateObj && dateObj.d && dateObj.m && dateObj.y) {
                        const day = String(dateObj.d).padStart(2, '0');
                        const month = String(dateObj.m).padStart(2, '0');
                        return `${day}/${month}/${dateObj.y}`;
                    }
                } catch (e) { console.error('Error convirtiendo fecha Excel', e); }
            }

            // Fecha como texto
            if (cell.v) {
                const val = String(cell.v);
                const match = val.match(dateRegex);
                if (match) return match[0]; 
            }
        }
    }
    return 'S/F';
}

function extractResponsibleInfo(sheet) {
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
    const contentRows = data.filter(row => row.some(cell => cell !== null && String(cell).trim() !== ''));

    // Intento 1: Buscar al final del archivo (firmas)
    if (contentRows.length >= 2) {
        const nameRow = contentRows[contentRows.length - 2];
        const titleRow = contentRows[contentRows.length - 1];
        
        const name = nameRow.find(cell => cell !== null && String(cell).trim() !== '');
        const title = titleRow.find(cell => cell !== null && String(cell).trim() !== '');

        if (name && title && isNaN(name) && isNaN(title) && String(name).length > 3 && String(title).length > 3) {
            return { name: String(name).trim(), title: String(title).trim() };
        }
    }

    // Intento 2: Buscar etiqueta "RESPONSABLE"
    for (let i = 0; i < data.length; i++) {
        const row = data[i];
        for (let j = 0; j < row.length; j++) {
            if (String(row[j]).trim().toLowerCase() === 'responsable') {
                if (i + 3 < data.length) {
                    const name = data[i + 2] ? String(data[i + 2][j] || '').trim() : null;
                    const title = data[i + 3] ? String(data[i + 3][j] || '').trim() : null;
                    if (name && title) return { name, title };
                }
            }
        }
    }
    return null;
}

// --- Importación de Inventario (Excel) ---

export function processFile(file) {
    if (state.readOnlyMode) return showToast('Modo de solo lectura: no se pueden cargar nuevos archivos.', 'warning');
    const fileName = file.name;

    const proceedWithUpload = () => {
        elements.loadingOverlay.overlay.classList.add('show');
        elements.dashboard.headerAndDashboard.classList.add('hidden');
        elements.loadingOverlay.text.textContent = 'Leyendo archivo...';

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const data = e.target.result;
                const workbook = XLSX.read(data, { type: 'binary' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                const tipoLibro = sheet['B7']?.v || sheet['L7']?.v || 'Sin Tipo';
                
                addItemsFromFile(sheet, tipoLibro, fileName);
            } catch (error) {
                console.error("Error processing file: ", error);
                showToast('Error al procesar el archivo. Asegúrate de que el formato es correcto.', 'error');
                elements.loadingOverlay.overlay.classList.remove('show');
            }
        };
        reader.onerror = () => {
            elements.loadingOverlay.overlay.classList.remove('show');
            showToast('Error al leer el archivo.', 'error');
        };
        reader.readAsBinaryString(file);
    };

    const isFileAlreadyLoaded = state.inventory.some(item => item.fileName === fileName);
    
    if (isFileAlreadyLoaded) {
        showConfirmationModal(
            'Archivo Duplicado',
            `El archivo "${fileName}" ya fue cargado. ¿Deseas reemplazar los datos existentes?`,
            () => {
                const itemsFromThisFile = state.inventory.filter(item => item.fileName === fileName).length;
                logActivity('Archivo reemplazado', `Archivo "${fileName}" con ${itemsFromThisFile} bienes fue reemplazado.`);
                state.inventory = state.inventory.filter(item => item.fileName !== fileName);
                proceedWithUpload();
            }
        );
    } else {
        proceedWithUpload();
    }
}

function addItemsFromFile(sheet, tipoLibro, fileName) {
    const areaString = sheet['A10']?.v || 'Sin Área';
    const area = areaString.match(/AREA\s(\d+)/)?.[1] || 'Sin Área';
    const printDate = findReportDateSmart(sheet);
    const listId = Date.now();
    
    if (area && !state.areaNames[area]) {
        state.areaNames[area] = areaString;
    }
    
    const responsible = extractResponsibleInfo(sheet);
    if (area && !state.areaDirectory[area]) {
        if (responsible) {
            state.areaDirectory[area] = {
                fullName: areaString,
                name: responsible.name,
                title: responsible.title,
            };
        }
    }

    const rawData = XLSX.utils.sheet_to_json(sheet, { header: 1, range: 11 });
    const totalRows = rawData.length;
    const claveUnicaRegex = /^(?:\d{5,6}|0\.\d+)$/;
    
    let processedRows = 0;
    const chunkSize = 500;
    const newItemsBatch = [];

    function processChunk() {
        const end = Math.min(processedRows + chunkSize, totalRows);
        
        for (let i = processedRows; i < end; i++) {
            const row = rawData[i];
            const clave = String(row[0] || '').trim();
            
            if (claveUnicaRegex.test(clave)) {
                newItemsBatch.push({
                    'CLAVE UNICA': clave, 
                    'DESCRIPCION': String(row[1] || ''), 
                    'OFICIO': row[2] || '', 
                    'TIPO': row[3] || '',
                    'MARCA': row[4] || '', 
                    'MODELO': row[5] || '', 
                    'SERIE': row[6] || '', 
                    'FECHA DE INICIO': row[7] || '',
                    'REMISIÓN': row[8] || '', 
                    'FECHA DE REMISIÓN': row[9] || '', 
                    'FACTURA': row[10] || '', 
                    'FECHA DE FACTURA': row[11] || '', 
                    'AÑO': row[12] || '',
                    'NOMBRE DE USUARIO': '', 
                    'UBICADO': 'NO', 
                    'IMPRIMIR ETIQUETA': 'NO',
                    'listadoOriginal': tipoLibro, 
                    'areaOriginal': area,
                    'listId': listId, 
                    'fileName': fileName, 
                    'printDate': printDate
                });
            }
        }

        processedRows = end;

        if (elements.loadingOverlay.text) {
            const percent = Math.round((processedRows / totalRows) * 100);
            elements.loadingOverlay.text.textContent = `Procesando: ${percent}% (${processedRows}/${totalRows} bienes)...`;
        }

        if (processedRows < totalRows) {
            setTimeout(processChunk, 0);
        } else {
            finalizeImport();
        }
    }

    function finalizeImport() {
        state.inventory = state.inventory.concat(newItemsBatch);
        state.inventoryFinished = false; 
        
        logActivity('Archivo cargado', `Archivo "${fileName}" con ${newItemsBatch.length} bienes para el área ${area}.`);

        const responsibleName = responsible?.name || 'No detectado';
        
        // Actualizar UI Global
        populateAreaSelects();
        populateReportFilters();
        populateBookTypeFilter();
        renderDashboard();
        renderLoadedLists();
        renderDirectory();
        updateSerialNumberCache();
        
        // Resetear vista de tabla
        renderInventoryTable([], 1, 50); // Se renderizará bien al cambiar filtro o buscar
        
        // Ocultar overlay y guardar
        elements.loadingOverlay.overlay.classList.remove('show');
        // Nota: saveState se debe llamar desde quien invoca esto o aquí mismo si importamos la función
        // En este diseño modular, files.js no importa saveState para evitar dependencias circulares si saveState estuviera en logic.js
        // Pero saveState está en state.js ahora, así que podemos usarlo.
        try {
             const stateToSave = { ...state };
             delete stateToSave.serialNumberCache;
             delete stateToSave.cameraStream;
             localStorage.setItem('inventarioProState', JSON.stringify(stateToSave));
        } catch(e) { console.error("Error guardando estado post-import", e); }

        showToast(`Área ${area}: Se cargaron ${newItemsBatch.length} bienes. Responsable: ${responsibleName}.`, 'success');
    }

    processChunk();
}

// --- Exportaciones (XLSX) ---

export function exportInventoryToXLSX() {
    const selectedArea = elements.reports.areaFilter.value;
    let inventoryToExport = state.inventory;
    let additionalToExport = state.additionalItems;
    let fileName = "inventario_completo.xlsx";
    let logMessage = "Exportando inventario completo.";

    if (selectedArea !== 'all') {
        inventoryToExport = state.inventory.filter(item => item.areaOriginal === selectedArea);
        const usersInArea = state.resguardantes
            .filter(user => user.area === selectedArea)
            .map(user => user.name);
        additionalToExport = state.additionalItems.filter(item => usersInArea.includes(item.usuario));
        fileName = `inventario_area_${selectedArea}.xlsx`;
        logMessage = `Exportando inventario área ${selectedArea}.`;
    }

    if (inventoryToExport.length === 0 && additionalToExport.length === 0) {
        return showToast('No hay datos para exportar con los filtros actuales.', 'warning');
    }

    showToast('Generando archivo XLSX...');
    logActivity('Exportación XLSX', logMessage);

    try {
        const workbook = XLSX.utils.book_new();

        const inventoryData = inventoryToExport.map(item => {
            let locationDisplay = item.ubicacionEspecifica;
            if (!locationDisplay) {
                const userData = state.resguardantes.find(u => u.name === item['NOMBRE DE USUARIO']);
                locationDisplay = userData ? (userData.locationWithId || 'Ubicación General') : 'N/A';
            }

            return {
                'Clave Unica': String(item['CLAVE UNICA']).startsWith('0.') ? item['CLAVE UNICA'].substring(1) : item['CLAVE UNICA'],
                'Descripcion': item['DESCRIPCION'],
                'Marca': item['MARCA'],
                'Modelo': item['MODELO'],
                'Serie': item['SERIE'],
                'Area Original': item.areaOriginal,
                'Usuario Asignado': item['NOMBRE DE USUARIO'],
                'Ubicación': locationDisplay,
                'Ubicado': item['UBICADO'],
                'Requiere Etiqueta': item['IMPRIMIR ETIQUETA'],
                'Tiene Foto': state.photos[item['CLAVE UNICA']] ? 'Si' : 'No',
                'Nota': state.notes[item['CLAVE UNICA']] || ''
            };
        });

        const inventoryWorksheet = XLSX.utils.json_to_sheet(inventoryData);
        XLSX.utils.book_append_sheet(workbook, inventoryWorksheet, "Inventario Principal");

        if (additionalToExport.length > 0) {
            const additionalData = additionalToExport.map(item => {
                 let locationDisplay = item.ubicacionEspecifica;
                 if (!locationDisplay) {
                     const userData = state.resguardantes.find(u => u.name === item.usuario);
                     locationDisplay = userData ? (userData.locationWithId || 'Ubicación General') : 'N/A';
                 }

                return {
                    'Descripcion': item.descripcion,
                    'Clave Original': item.clave || 'N/A',
                    'Marca': item.marca || 'N/A',
                    'Modelo': item.modelo || 'N/A',
                    'Serie': item.serie || 'N/A',
                    'Area Procedencia': item.area || 'N/A',
                    'Usuario Asignado': item.usuario,
                    'Ubicación': locationDisplay,
                    'Es Personal': item.personal,
                    'Clave Asignada': item.claveAsignada || 'N/A'
                };
            });
            const additionalWorksheet = XLSX.utils.json_to_sheet(additionalData);
            XLSX.utils.book_append_sheet(workbook, additionalWorksheet, "Bienes Adicionales");
        }

        XLSX.writeFile(workbook, fileName);
        showToast('Archivo XLSX generado con éxito.', 'success');
    } catch (error) {
        console.error("Error generating XLSX file:", error);
        showToast('Hubo un error al generar el archivo XLSX.', 'error');
    }
}

export function exportLabelsToXLSX() {
    const itemsToLabel = state.inventory.filter(item => item['IMPRIMIR ETIQUETA'] === 'SI');
    const additionalItemsToLabel = state.additionalItems.filter(item => item.claveAsignada);

    if (itemsToLabel.length === 0 && additionalItemsToLabel.length === 0) {
        return showToast('No hay bienes marcados para etiquetar.', 'info');
    }
    
    showToast('Generando reporte de etiquetas...');
    logActivity('Exportación XLSX', `Etiquetas: ${itemsToLabel.length} inv, ${additionalItemsToLabel.length} adic.`);

    try {
        const inventoryData = itemsToLabel.map(item => {
            let locationDisplay = item.ubicacionEspecifica;
            if (!locationDisplay) {
                const userData = state.resguardantes.find(u => u.name === item['NOMBRE DE USUARIO']);
                locationDisplay = userData ? (userData.locationWithId || userData.area) : 'N/A';
            }
            const claveUnica = String(item['CLAVE UNICA']);
            return {
                'Clave única': claveUnica.startsWith('0.') ? claveUnica.substring(1) : claveUnica,
                'Descripción': item['DESCRIPCION'],
                'Usuario': item['NOMBRE DE USUARIO'] || 'Sin Asignar',
                'Ubicación': locationDisplay,
                'Área': state.resguardantes.find(u => u.name === item['NOMBRE DE USUARIO'])?.area || 'N/A'
            };
        });

        const additionalData = additionalItemsToLabel.map(item => {
             return {
                'Clave única': item.claveAsignada,
                'Descripción': item.descripcion,
                'Usuario': item.usuario || 'Sin Asignar',
                'Área': state.resguardantes.find(u => u.name === item.usuario)?.area || 'N/A'
            };
        });

        const combinedData = [...inventoryData, ...additionalData];
        const worksheet = XLSX.utils.json_to_sheet(combinedData);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, "Etiquetas");

        XLSX.writeFile(workbook, "reporte_etiquetas_combinado.xlsx");
        showToast('Reporte de etiquetas generado.', 'success');
    } catch (error) {
        console.error(error);
        showToast('Error al generar etiquetas.', 'error');
    }
}

// --- Backup Completo (ZIP) ---

export async function exportSession(isFinal = false) {
    const { overlay, text } = elements.loadingOverlay;
    const type = isFinal ? 'FINALIZADO' : 'backup-editable';
    text.textContent = 'Generando respaldo...';
    overlay.classList.add('show');

    try {
        const zip = new JSZip();

        const stateToSave = { ...state };
        if (isFinal) stateToSave.readOnlyMode = true;
        delete stateToSave.serialNumberCache;
        delete stateToSave.cameraStream;
        
        zip.file("session.json", JSON.stringify(stateToSave));

        text.textContent = 'Empaquetando fotos...';
        const allPhotos = await photoDB.getAllItems('photos');
        if (allPhotos.length > 0) {
            const photoFolder = zip.folder("photos");
            for (const { key, value } of allPhotos) {
                photoFolder.file(key, value);
            }
        }
        
        text.textContent = 'Empaquetando croquis...';
        const allLayoutImages = await photoDB.getAllItems('layoutImages');
         if (allLayoutImages.length > 0) {
            const layoutImageFolder = zip.folder("layoutImages");
            for (const { key, value } of allLayoutImages) {
                layoutImageFolder.file(key, value);
            }
        }
        
        text.textContent = 'Comprimiendo...';
        const content = await zip.generateAsync({ type: "blob" });

        const a = document.createElement('a');
        const date = new Date().toISOString().slice(0, 10);
        a.href = URL.createObjectURL(content);
        a.download = `inventario-${type}-${date}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);

        logActivity('Sesión exportada', `Tipo: ${type}`);
        showToast(`Sesión exportada con éxito.`);
    } catch (e) {
        console.error('Error al exportar ZIP:', e);
        showToast('Error al exportar la sesión.', 'error');
    } finally {
        overlay.classList.remove('show');
    }
}

export async function importSession(file) {
    if (!file || !file.name.endsWith('.zip')) {
        return showToast('Por favor, selecciona un archivo .zip válido.', 'error');
    }
    
    logActivity('Importación de sesión', `Archivo: ${file.name}`);
    const { overlay, text } = elements.loadingOverlay;
    text.textContent = 'Abriendo respaldo...';
    overlay.classList.add('show');

    try {
        const jszip = new JSZip();
        const zip = await jszip.loadAsync(file);
        
        const sessionFile = zip.file('session.json');
        if (!sessionFile) throw new Error('El ZIP no contiene session.json.');

        const sessionData = await sessionFile.async('string');
        const importedState = JSON.parse(sessionData);
        
        // Restaurar Fotos
        const photoFolder = zip.folder("photos");
        if (photoFolder) {
            overlay.classList.remove('show');
            elements.importProgress.modal.classList.add('show');
            
            const photoFiles = [];
            photoFolder.forEach((relativePath, file) => {
                if (!file.dir) photoFiles.push(file);
            });
            
            let processed = 0;
            const total = photoFiles.length;
            
            for (const f of photoFiles) {
                const key = f.name.split('/').pop();
                const blob = await f.async("blob");
                await photoDB.setItem('photos', key, blob);
                processed++;
                
                const percent = Math.round((processed / total) * 100);
                elements.importProgress.bar.style.width = `${percent}%`;
                elements.importProgress.bar.textContent = `${percent}%`;
                elements.importProgress.text.textContent = `Restaurando foto ${processed}/${total}...`;
            }
            elements.importProgress.modal.classList.remove('show');
        }
        
        // Restaurar Imágenes de Croquis
        const layoutImageFolder = zip.folder("layoutImages");
        if (layoutImageFolder) {
             const layoutFiles = [];
            layoutImageFolder.forEach((relativePath, file) => {
                if (!file.dir) layoutFiles.push(file);
            });
            for (const f of layoutFiles) {
                const key = f.name.split('/').pop();
                const blob = await f.async("blob");
                await photoDB.setItem('layoutImages', key, blob);
            }
        }
        
        localStorage.setItem('inventarioProState', JSON.stringify(importedState));
        showToast('Sesión importada. Recargando...', 'success');
        setTimeout(() => window.location.reload(), 1500);

    } catch (err) {
        console.error("Error import:", err);
        showToast('Error al importar respaldo.', 'error');
        overlay.classList.remove('show');
        elements.importProgress.modal.classList.remove('show');
    }
}

export async function restorePhotosFromBackup(file) {
    if (!file) return;
    const { modal, text, bar } = elements.importProgress;
    modal.classList.add('show');

    const inventoryClaves = new Set(state.inventory.map(item => String(item['CLAVE UNICA'])));
    let successCount = 0;
    let ignoredCount = 0;

    try {
        const jszip = new JSZip();
        const zip = await jszip.loadAsync(file);
        const photoFolder = zip.folder("photos");
        
        if (!photoFolder) throw new Error('No hay carpeta photos en el ZIP.');

        const photoFiles = [];
        photoFolder.forEach((relativePath, file) => {
            if (!file.dir) photoFiles.push(file);
        });

        for (let i = 0; i < photoFiles.length; i++) {
            const f = photoFiles[i];
            const key = f.name.split('/').pop();
            const clave = key.replace(/^(inventory-|additional-|location-)/, '');
            
            const percent = Math.round(((i + 1) / photoFiles.length) * 100);
            bar.style.width = `${percent}%`;
            bar.textContent = `${percent}%`;
            text.textContent = `Restaurando ${i + 1}/${photoFiles.length}...`;

            if (inventoryClaves.has(clave)) {
                const blob = await f.async("blob");
                await photoDB.setItem('photos', key, blob);
                if (key.startsWith('inventory-')) state.photos[clave] = true;
                if (key.startsWith('additional-')) state.additionalPhotos[clave] = true;
                successCount++;
            } else {
                ignoredCount++;
            }
        }

        modal.classList.remove('show');
        if (successCount > 0) {
            try {
                 const stateToSave = { ...state };
                 delete stateToSave.serialNumberCache;
                 delete stateToSave.cameraStream;
                 localStorage.setItem('inventarioProState', JSON.stringify(stateToSave));
            } catch(e) {}
            
            showToast(`${successCount} fotos restauradas.`, 'success');
        } else {
            showToast('No se restauraron fotos (claves no coinciden).', 'warning');
        }

    } catch (err) {
        modal.classList.remove('show');
        console.error(err);
        showToast('Error procesando el backup.', 'error');
    }
}