// Initialize camera feed
import OpenAI from 'https://esm.sh/openai?bundle';

// --- OpenAI Vision setup ---
let openaiClient = null;
function getOpenAIClient() {
  if (!openaiApiKey) return null;
  if (openaiClient) return openaiClient;
  openaiClient = new OpenAI({ apiKey: openaiApiKey, dangerouslyAllowBrowser: true });
  return openaiClient;
}

// Analyse an image with GPT-4o Vision style prompt. Accepts a question and a data-URL or remote image URL.
async function askImageQuestion(question, imageUrl) {
  const client = getOpenAIClient();
  if (!client) return null;
  try {
    const resp = await client.responses.create({
      model: 'gpt-4o',
      input: [
        { role: 'user', content: question },
        {
          role: 'user',
          content: [
            { type: 'input_image', image_url: imageUrl }
          ]
        }
      ]
    });
    return resp.output_text || '';
  } catch (err) {
    console.warn('OpenAI Vision request failed', err);
    return null;
  }
}

// Extract structured JSON directly from an image using GPT-4o Vision
async function extractInfoVision(imageUrl) {
  const client = getOpenAIClient();
  if (!client) return null;
  try {
    const resp = await client.responses.create({
      model: 'gpt-4o',
      input: [
        {
          role: 'user',
          content:
            'Extract JSON with keys: storeName, unitNumber, address, category. For category, choose the most appropriate from: Art, Attractions, Auto, Beauty Services, Commercial Building, Education, Essentials, Financial, Food and Beverage, General Merchandise, Government Building, Healthcare, Home Services, Hotel, Industrial, Local Services, Mass Media, Nightlife, Physical Feature, Professional Services, Religious Organization, Residential, Sports and Fitness, Travel. Use "Not Found" if unknown.'
        },
        {
          role: 'user',
          content: [{ type: 'input_image', image_url: imageUrl }]
        }
      ]
    });
    const txt = resp.output_text || '';
    const match = txt.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch (err) {
    console.warn('Vision JSON extraction failed', err);
    return null;
  }
}
const video = document.getElementById('camera');
const statusDiv = document.getElementById('status');
const tableBody = document.querySelector('#resultsTable tbody');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
// --- NEW: Scanning overlay elements ---
const scanningOverlay = document.getElementById('scanningOverlay');
const scanningText = document.querySelector('.scanning-text');
// --- NEW: Image upload elements ---
const uploadBtn = document.getElementById('uploadBtn');
const imageInput = document.getElementById('imageInput');
// --- NEW: Zoom control elements ---
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomResetBtn = document.getElementById('zoomReset');
const zoomLevelSpan = document.getElementById('zoomLevel');

// Persistent scans storage
let scans = [];
// --- Networking helpers and timeouts ---
const GEO_FAST_TIMEOUT_MS = 3000; // 3s fast location for scans
const SEARCH_TIMEOUT_MS = 4000;   // 4s for OneMap search
const REVERSE_TIMEOUT_MS = 4000;  // 4s for reverse geocode

async function fetchWithTimeout(url, { timeoutMs, ...options } = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs || 5000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}


// Photo storage and deferred save utilities
const PHOTO_DB_NAME = 'bnsv_photo_db';
const PHOTO_STORE = 'photos';
let saveScansScheduled = false;

function scheduleSaveScans() {
  if (saveScansScheduled) return;
  saveScansScheduled = true;
  const ric = window.requestIdleCallback || function(cb){ return setTimeout(cb, 0); };
  ric(() => {
    try {
      localStorage.setItem('scans', JSON.stringify(scans));
    } finally {
      saveScansScheduled = false;
    }
  });
}

// Sanitize helpers: convert placeholders like "Not Found"/"Unknown" to blanks
function sanitizeString(value) {
  const v = (value == null ? '' : String(value)).trim();
  if (!v) return '';
  const lower = v.toLowerCase();
  if (lower === 'not found' || lower === 'unknown' || lower === 'n/a') return '';
  return v;
}

function sanitizeObjectStrings(obj) {
  const out = { ...obj };
  for (const key in out) {
    if (typeof out[key] === 'string') {
      out[key] = sanitizeString(out[key]);
    }
  }
  return out;
}

function openPhotoDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(PHOTO_DB_NAME, 1);
    req.onupgradeneeded = function(e) {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        db.createObjectStore(PHOTO_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePhotoBlob(photoId, blob, filename) {
  try {
    const db = await openPhotoDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readwrite');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.objectStore(PHOTO_STORE).put({ id: photoId, blob, filename });
    });
  } catch (_) { /* ignore */ }
}

async function getPhotoBlob(photoId) {
  try {
    const db = await openPhotoDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, 'readonly');
      tx.onerror = () => reject(tx.error);
      const req = tx.objectStore(PHOTO_STORE).get(photoId);
      req.onsuccess = () => resolve(req.result ? req.result.blob : null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

function createThumbnailDataURL(sourceCanvas, maxWidth = 400, maxHeight = 400, quality = 0.6) {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const scale = Math.min(maxWidth / w, maxHeight / h, 1);
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const thumb = document.createElement('canvas');
  thumb.width = outW;
  thumb.height = outH;
  const ctx = thumb.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0, outW, outH);
  return thumb.toDataURL('image/jpeg', quality);
}

// Migrate existing data to include photo fields if missing
function migrateScansData() {
  scans = scans.map(scan => {
    // Ensure all new fields exist with default values
    return {
      ...scan,
      photoData: scan.photoData || null,
      timestamp: scan.timestamp || new Date().toISOString(),
      photoFilename: scan.photoFilename || null,
      houseNo: scan.houseNo || '',
      street: scan.street || '', 
      building: scan.building || '',
      postcode: scan.postcode || ''
    };
  });
  saveScans();
}
// Note: openaiApiKey is defined later, but we need it before using getOpenAIClient().
// We will forward-declare it here and assign when loaded below.
let openaiApiKey;
let oneMapApiKey;

// --- Scanning overlay helper functions ---
function showScanningOverlay(text = 'Scanning...') {
  if (scanningOverlay && scanningText) {
    scanningText.textContent = text;
    scanningOverlay.classList.add('show');
  }
}

function hideScanningOverlay() {
  if (scanningOverlay) {
    scanningOverlay.classList.remove('show');
  }
}

function showScanComplete() {
  if (scanningText) {
    scanningText.textContent = '✓ Done!';
    // Hide the spinner when done
    const spinner = document.querySelector('.spinner');
    if (spinner) {
      spinner.style.display = 'none';
    }
    // Hide overlay after 1.5 seconds
    setTimeout(() => {
      hideScanningOverlay();
      // Reset spinner visibility for next scan
      if (spinner) {
        spinner.style.display = 'block';
      }
    }, 1500);
  }
} // OneMap API key for authenticated endpoints
openaiApiKey = localStorage.getItem('openaiApiKey') || '';
// oneMapApiKey removed – switching to Nominatim for reverse geocoding
try {
  scans = JSON.parse(localStorage.getItem('scans') || '[]');
} catch (_) { scans = []; }

// Ensure newest-first ordering by timestamp
function sortScansNewestFirst() {
  try {
    scans.sort((a, b) => {
      const at = Date.parse((a && a.timestamp) ? a.timestamp : 0);
      const bt = Date.parse((b && b.timestamp) ? b.timestamp : 0);
      return bt - at;
    });
  } catch (_) {}
}

// Migrate existing data to new structure
if (scans.length > 0) {
  migrateScansData();
}

// Background migration: move full-res photos to IndexedDB and keep thumbnails in localStorage
async function migrateExistingPhotosToIndexedDB() {
  let migratedCount = 0;
  for (let i = 0; i < scans.length; i++) {
    const scan = scans[i];
    if (!scan) continue;
    const hasInlinePhoto = scan.photoData && typeof scan.photoData === 'string' && scan.photoData.startsWith('data:image/');
    const alreadyMigrated = !!scan.photoId;
    if (!hasInlinePhoto || alreadyMigrated) continue;

    try {
      const timestamp = scan.timestamp || new Date().toISOString();
      const photoId = `photo_${timestamp.replace(/[:.]/g, '-').slice(0, -5)}_${Math.random().toString(36).slice(2,8)}`;
      const photoFilename = scan.photoFilename || `bnsVision_${scan.storeName || 'scan'}_${timestamp.replace(/[:.]/g, '-').slice(0, -5)}.jpg`;

      // Convert data URL to Blob
      const res = await fetch(scan.photoData);
      const blob = await res.blob();
      await savePhotoBlob(photoId, blob, photoFilename);

      // Create thumbnail from existing image
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = scan.photoData;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const thumbDataUrl = createThumbnailDataURL(canvas, 400, 400, 0.6);

      scans[i] = {
        ...scan,
        photoData: thumbDataUrl,
        photoId,
        photoFilename
      };
      migratedCount++;
      // Yield to UI occasionally
      if (migratedCount % 3 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    } catch (_) {
      // Ignore individual migration failures
    }
  }
  if (migratedCount > 0) {
    saveScans();
    renderTable();
  }
}

// Kick off migration shortly after load
setTimeout(() => { migrateExistingPhotosToIndexedDB(); }, 500);

// Sort once on load so newest entries appear first
sortScansNewestFirst();

renderTable();

function saveScans() {
  scheduleSaveScans();
}

function renderTable() {
  if (!tableBody) return;
  
  // Clear any existing search highlights when re-rendering
  clearSearchHighlights();
  
  tableBody.innerHTML = '';
  console.log('Rendering table with', scans.length, 'scans');
  scans.forEach((scan, idx) => {
    console.log(`Rendering scan ${idx}:`, {
      storeName: scan.storeName,
      hasPhoto: !!scan.photoData,
      keys: Object.keys(scan)
    });
    
    // Create the main table row
    const tr = document.createElement('tr');
    tr.className = 'table-row';
    tr.dataset.index = idx;
    
    // Add table cells with data including remarks
    const remarksValue = scan.remarks || '';
    
    // Format Lat-Long as a single field
    const latLong = (scan.lat && scan.lng) 
      ? `${scan.lat}, ${scan.lng}` 
      : '';
    
    // Parse address components
    const houseNo = scan.houseNo || '';
    const street = scan.street || '';
    const building = scan.building || '';
    const postcode = scan.postcode || '';
    
    // Create photo cell content - ensure it's always a complete cell
    let photoCell;
    if (scan.photoData && scan.photoData.trim() !== '') {
      photoCell = `
        <div class="photo-cell">
          <img src="${scan.photoData}" alt="Store photo" class="photo-thumbnail" data-index="${idx}" title="Click to enlarge">
          <button class="photo-download-btn" data-index="${idx}" title="Download photo">⬇️</button>
        </div>
      `;
    } else {
      photoCell = `
        <div class="photo-cell">
          <div class="no-photo">📷</div>
          <span style="font-size: 9px; color: #999;">No photo</span>
        </div>
      `;
    }

    const rowHTML = `
      <td>${idx + 1}</td>
      <td>${photoCell}</td>
      <td>${scan.storeName}</td>
      <td>${latLong}</td>
      <td>${houseNo}</td>
      <td>${street}</td>
      <td>${scan.unitNumber}</td>
      <td>${building}</td>
      <td>${postcode}</td>
      <td class="remarks-cell">
        <input type="text" class="remarks-input" value="${remarksValue}" 
               placeholder="Add remarks..." data-index="${idx}">
      </td>
      <td class="actions-cell">
        <button class="edit-btn" data-index="${idx}" title="Edit Row">
          ✏️ Edit
        </button>
        <button class="delete-btn" data-index="${idx}" title="Delete Row">
          🗑️ Delete
        </button>
      </td>`;
    
    console.log(`Row HTML for scan ${idx}:`, rowHTML.substring(0, 200) + '...');
    tr.innerHTML = rowHTML;
    
    // Append row to table
    tableBody.appendChild(tr);
    
    // Add event listeners for remarks input
    const remarksInput = tr.querySelector('.remarks-input');
    remarksInput.addEventListener('blur', (e) => {
      const index = parseInt(e.target.dataset.index);
      scans[index].remarks = e.target.value;
      saveScans();
    });
    
    remarksInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        e.target.blur(); // This will trigger the blur event above
      }
    });
    
    // Add event listeners for action buttons
    const editBtn = tr.querySelector('.edit-btn');
    const deleteBtn = tr.querySelector('.delete-btn');
    
    editBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const index = parseInt(e.target.dataset.index);
      editRow(index);
    });
    
    deleteBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const index = parseInt(e.target.dataset.index);
      deleteRow(index);
    });

    // Add event listeners for photo interactions
    const photoThumbnail = tr.querySelector('.photo-thumbnail');
    const photoDownloadBtn = tr.querySelector('.photo-download-btn');
    
    if (photoThumbnail) {
      photoThumbnail.addEventListener('click', async (e) => {
        e.preventDefault();
        const index = parseInt(e.target.dataset.index);
        const scan = scans[index];
        try {
          let url = scan.photoData;
          if (scan.photoId) {
            const blob = await getPhotoBlob(scan.photoId);
            if (blob) {
              url = URL.createObjectURL(blob);
            }
          }
          showPhotoModal(url, scan.storeName);
        } catch (_) {
          showPhotoModal(scan.photoData, scan.storeName);
        }
      });
    }
    
    if (photoDownloadBtn) {
      photoDownloadBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const index = parseInt(e.target.dataset.index);
        downloadPhoto(scans[index]);
      });
    }
  });
}

// Edit individual row
function editRow(index) {
  const scan = scans[index];
  if (!scan) return;
  
  // Create a simple modal for editing
  const modal = document.createElement('div');
  modal.className = 'edit-modal';
  modal.innerHTML = `
    <div class="edit-modal-content">
      <h3>Edit Scan #${index + 1}</h3>
      <div class="edit-form">
        <div class="edit-field">
          <label>POI Name:</label>
          <input type="text" id="edit-storeName" value="${scan.storeName}">
        </div>
        <div class="edit-field">
          <label>Latitude:</label>
          <input type="text" id="edit-lat" value="${scan.lat || ''}">
        </div>
        <div class="edit-field">
          <label>Longitude:</label>
          <input type="text" id="edit-lng" value="${scan.lng || ''}">
        </div>
        <div class="edit-field">
          <label>House_No:</label>
          <input type="text" id="edit-houseNo" value="${scan.houseNo || ''}">
        </div>
        <div class="edit-field">
          <label>Street:</label>
          <input type="text" id="edit-street" value="${scan.street || ''}">
        </div>
        <div class="edit-field">
          <label>Unit:</label>
          <input type="text" id="edit-unitNumber" value="${scan.unitNumber}">
        </div>
        <div class="edit-field">
          <label>Building:</label>
          <input type="text" id="edit-building" value="${scan.building || ''}">
        </div>
        <div class="edit-field">
          <label>Postcode:</label>
          <input type="text" id="edit-postcode" value="${scan.postcode || ''}">
        </div>
        <div class="edit-field">
          <label>Remarks:</label>
          <input type="text" id="edit-remarks" value="${scan.remarks || ''}">
        </div>
        ${scan.photoData ? `
        <div class="edit-field">
          <label>Photo Preview:</label>
          <div style="display: flex; align-items: center; gap: 10px;">
            <img src="${scan.photoData}" alt="Scan photo" style="width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border: 2px solid #e0e0e0;">
            <button type="button" class="btn" onclick="showPhotoModal('${scan.photoData}', '${scan.storeName}')">🔍 View Full Size</button>
          </div>
        </div>
        ` : '<div class="edit-field"><label>Photo:</label><span style="color: #999;">No photo captured</span></div>'}
        <div class="edit-actions">
          <button class="btn save-btn">💾 Save</button>
          <button class="btn cancel-btn">❌ Cancel</button>
        </div>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Add event listeners
  const saveBtn = modal.querySelector('.save-btn');
  const cancelBtn = modal.querySelector('.cancel-btn');
  
  const closeModal = () => {
    document.body.removeChild(modal);
  };
  
  saveBtn.addEventListener('click', () => {
    // Update scan data
    scans[index] = {
      ...scan,
      storeName: document.getElementById('edit-storeName').value,
      lat: document.getElementById('edit-lat').value,
      lng: document.getElementById('edit-lng').value,
      houseNo: document.getElementById('edit-houseNo').value,
      street: document.getElementById('edit-street').value,
      unitNumber: document.getElementById('edit-unitNumber').value,
      building: document.getElementById('edit-building').value,
      postcode: document.getElementById('edit-postcode').value,
      remarks: document.getElementById('edit-remarks').value
    };
    
    saveScans();
    renderTable();
    closeModal();
  });
  
  cancelBtn.addEventListener('click', closeModal);
  
  // Close modal when clicking outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Focus first input
  setTimeout(() => {
    document.getElementById('edit-storeName').focus();
  }, 100);
}

// Delete individual row
function deleteRow(index) {
  if (confirm(`Delete scan #${index + 1}?`)) {
    scans.splice(index, 1);
    saveScans();
    renderTable();
  }
}

// Show photo in enlarged modal
function showPhotoModal(photoData, storeName) {
  const modal = document.createElement('div');
  modal.className = 'photo-modal';
  modal.innerHTML = `
    <div class="photo-modal-content">
      <button class="photo-modal-close" title="Close">×</button>
      <img src="${photoData}" alt="${storeName} photo">
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const closeModal = () => {
    document.body.removeChild(modal);
  };
  
  // Close on button click
  modal.querySelector('.photo-modal-close').addEventListener('click', closeModal);
  
  // Close on background click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeModal();
    }
  });
  
  // Close on Escape key
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', handleKeyDown);
    }
  };
  document.addEventListener('keydown', handleKeyDown);
}

// Download individual photo
async function downloadPhoto(scan) {
  if (!scan.photoData) {
    alert('No photo available for this scan');
    return;
  }
  
  try {
    let blob = null;
    if (scan.photoId) {
      blob = await getPhotoBlob(scan.photoId);
    }
    if (!blob && scan.photoData && scan.photoData.startsWith('data:image/')) {
      const res = await fetch(scan.photoData);
      blob = await res.blob();
    }
    if (!blob) {
      alert('Photo data not available');
      return;
    }
    const filename = scan.photoFilename || `bnsVision_${scan.storeName || 'scan'}_photo.jpg`;

    // Prefer Web Share API on mobile (iOS/Android)
    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([blob], filename, { type: 'image/jpeg' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'bnsVision Photo', files: [file] });
          showPhotoSavedNotification('📤 Photo shared');
          return;
        }
      } catch (shareErr) {
        if (shareErr && shareErr.name === 'AbortError') return; // user cancelled
        // fall through to download
      }
    }

    const objectUrl = URL.createObjectURL(blob);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (isIOS) {
      // iOS Safari often ignores download attribute; open in new tab for long-press save
      window.open(objectUrl, '_blank');
      showPhotoSavedNotification('📸 Tap and hold image to Save', false);
    } else {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showPhotoSavedNotification('Photo downloaded successfully!', false);
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  } catch (error) {
    console.error('Download failed:', error);
    showPhotoSavedNotification('Download failed. Please try again.', true);
  }
}

// Removed old swipe functionality - now using buttons

// After renderTable definition add event listeners
// --- Toolbar actions ---
document.getElementById('clearBtn').addEventListener('click', () => {
  if (confirm('Clear all saved scans?')) {
    scans = [];
    saveScans();
    renderTable();
    if (video && video.srcObject) {
      video.play().catch(()=>{});
    }
  }
});

document.getElementById('exportBtn').addEventListener('click', () => {
  if (!scans.length) {
    alert('No data to export');
    return;
  }
  const headers = ['POI Name','Lat-Long','House_No','Street','Unit','Building','Postcode','Remarks','Photo Available','Timestamp'];
  const csvRows = [headers.join(',')];
  scans.forEach(s => {
    // Format Lat-Long as a single field
    const latLong = (s.lat && s.lng) ? `${s.lat}, ${s.lng}` : '';
    
    const row = [
      s.storeName, 
      latLong,
      s.houseNo || '', 
      s.street || '', 
      s.unitNumber, 
      s.building || '', 
      s.postcode || '', 
      s.remarks || '',
      s.photoData ? 'Yes' : 'No',
      s.timestamp || 'Unknown'
    ].map(v => '"' + (v || '').replace(/"/g,'""') + '"').join(',');
    csvRows.push(row);
  });
  const blob = new Blob([csvRows.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'storefront_scans.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0);
});

// Download All Photos functionality
document.getElementById('downloadAllPhotosBtn').addEventListener('click', async () => {
  const photosWithData = scans.filter(scan => scan.photoData);
  
  if (photosWithData.length === 0) {
    alert('No photos available to download');
    return;
  }
  
  if (photosWithData.length === 1) {
    // If only one photo, just download it directly
    downloadPhoto(photosWithData[0]);
    return;
  }
  
  // For multiple photos, create a ZIP file
  try {
    // Show progress
    const originalText = document.getElementById('downloadAllPhotosBtn').textContent;
    document.getElementById('downloadAllPhotosBtn').textContent = '📦 Preparing...';
    document.getElementById('downloadAllPhotosBtn').disabled = true;
    
    // Import JSZip dynamically
    if (!window.JSZip) {
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      document.head.appendChild(script);
      
      await new Promise((resolve, reject) => {
        script.onload = resolve;
        script.onerror = reject;
      });
    }
    
    const zip = new JSZip();
    const timestamp = new Date().toISOString().slice(0, 10);
    
    // Add each photo to the zip (prefer full-res from IndexedDB; fallback to thumbnail)
    const addPromises = photosWithData.map(async (scan, index) => {
      const filename = scan.photoFilename || `bnsVision_${scan.storeName || `scan_${index + 1}`}_photo.jpg`;
      let blob = null;
      if (scan.photoId) {
        blob = await getPhotoBlob(scan.photoId);
      }
      if (!blob && scan.photoData && scan.photoData.startsWith('data:image/')) {
        const res = await fetch(scan.photoData);
        blob = await res.blob();
      }
      if (blob) {
        const arrayBuffer = await blob.arrayBuffer();
        zip.file(filename, arrayBuffer);
      }
    });
    await Promise.all(addPromises);
    
    // Generate ZIP file
    document.getElementById('downloadAllPhotosBtn').textContent = '📦 Creating ZIP...';
    const zipBlob = await zip.generateAsync({type: 'blob'});

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const zipName = `bnsVision_all_photos_${timestamp}.zip`;

    // Prefer Web Share API when possible (iOS/Android)
    if (navigator.share && navigator.canShare) {
      try {
        const file = new File([zipBlob], zipName, { type: 'application/zip' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ title: 'bnsVision Photos', files: [file] });
          showPhotoSavedNotification(`📤 Shared ${photosWithData.length} photos`, false);
          return;
        }
      } catch (shareErr) {
        if (shareErr && shareErr.name === 'AbortError') return; // user cancelled
        // fall through
      }
    }

    const zipUrl = URL.createObjectURL(zipBlob);
    if (isIOS) {
      // iOS: open in new tab so user can use "Open in..." to save to Files
      window.open(zipUrl, '_blank');
      showPhotoSavedNotification('📦 Tap Share → Save to Files', false);
    } else {
      const link = document.createElement('a');
      link.href = zipUrl;
      link.download = zipName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showPhotoSavedNotification(`Downloaded ${photosWithData.length} photos`, false);
    }
    setTimeout(() => URL.revokeObjectURL(zipUrl), 2000);
    
    showPhotoSavedNotification(`Successfully downloaded ${photosWithData.length} photos as ZIP file!`, false);
    
  } catch (error) {
    console.error('Bulk download failed:', error);
    showPhotoSavedNotification('Failed to create photo archive. Try downloading photos individually.', true);
  } finally {
    // Reset button
    document.getElementById('downloadAllPhotosBtn').textContent = originalText;
    document.getElementById('downloadAllPhotosBtn').disabled = false;
  }
});

// Removed combined Export All handler

// --- Manual store location search ---
const storeSearchInput = document.getElementById('storeSearchInput');
const searchLocationBtn = document.getElementById('searchLocationBtn');

function performTableSearch() {
  const searchQuery = storeSearchInput.value.trim();
  
  // Clear previous highlights
  clearSearchHighlights();
  
  if (!searchQuery) {
    statusDiv.textContent = '';
    return;
  }

  if (scans.length === 0) {
    statusDiv.textContent = 'No data to search through';
    setTimeout(() => {
      statusDiv.textContent = '';
    }, 2000);
    return;
  }

  // Search through the scans data
  const foundIndices = [];
  const searchLower = searchQuery.toLowerCase();
  
  scans.forEach((scan, index) => {
    // Search in store name (primary field)
    if (scan.storeName && scan.storeName.toLowerCase().includes(searchLower)) {
      foundIndices.push(index);
      return;
    }
    
    // Also search in other fields for comprehensive results
    const searchableFields = [
      scan.unitNumber,
      scan.address,
      scan.category,
      scan.remarks,
      scan.houseNo,
      scan.street,
      scan.building,
      scan.postcode
    ];
    
    for (const field of searchableFields) {
      if (field && field.toString().toLowerCase().includes(searchLower)) {
        foundIndices.push(index);
        break; // Don't add the same row multiple times
      }
    }
  });

  if (foundIndices.length > 0) {
    // Highlight found rows
    highlightSearchResults(foundIndices);
    
    // Update status
    const plural = foundIndices.length === 1 ? 'result' : 'results';
    statusDiv.textContent = `Found ${foundIndices.length} ${plural} for "${searchQuery}"`;
    
    // Scroll to first result
    scrollToSearchResult(foundIndices[0]);
    
    // Clear status after 5 seconds
    setTimeout(() => {
      statusDiv.textContent = '';
    }, 5000);
  } else {
    statusDiv.textContent = `No results found for "${searchQuery}"`;
    setTimeout(() => {
      statusDiv.textContent = '';
    }, 3000);
  }
}

function clearSearchHighlights() {
  // Remove highlight class from all rows
  const allRows = document.querySelectorAll('.table-row');
  allRows.forEach(row => {
    row.classList.remove('search-highlight');
  });
}

function highlightSearchResults(indices) {
  // Add highlight class to found rows
  const allRows = document.querySelectorAll('.table-row');
  indices.forEach(index => {
    if (allRows[index]) {
      allRows[index].classList.add('search-highlight');
    }
  });
}

function scrollToSearchResult(index) {
  // Scroll to the first found result
  const allRows = document.querySelectorAll('.table-row');
  if (allRows[index]) {
    allRows[index].scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });
  }
}

searchLocationBtn.addEventListener('click', performTableSearch);

// Allow Enter key to trigger search
storeSearchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    performTableSearch();
  }
});

// Clear search highlights when input is cleared
storeSearchInput.addEventListener('input', (e) => {
  if (e.target.value.trim() === '') {
    clearSearchHighlights();
    statusDiv.textContent = '';
  }
});

// ---------- Geolocation ----------
let currentLocation = { lat: '', lng: '' };

async function initLocation() {
  statusDiv.textContent = 'Requesting location…';
  currentLocation = await getCurrentLocation(true);
  if (!currentLocation.lat) {
    statusDiv.textContent = 'Location unavailable – scans will show N/A';
  } else {
    statusDiv.textContent = '';
  }
}

// call immediately
initLocation();

function getCurrentLocation(initial = false) {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({ lat: '', lng: '' });

    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude, longitude } = pos.coords;
        resolve({ lat: latitude.toFixed(6), lng: longitude.toFixed(6) });
      },
      err => {
        if (!initial) console.warn('Geolocation error', err.message);
        resolve({ lat: '', lng: '' });
      },
      { enableHighAccuracy: true, timeout: GEO_FAST_TIMEOUT_MS, maximumAge: 60000 }
    );
  });
}

// --- Reverse geocoding via OpenStreetMap Nominatim (Singapore) ---
// Converts lat/lon to structured address parts using Nominatim and returns
// an object with { address, houseNo, street, building, postcode }.
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&addressdetails=1&namedetails=1&zoom=18`;
    const headers = { 'Accept': 'application/json' };
    const res = await fetchWithTimeout(url, { headers, timeoutMs: REVERSE_TIMEOUT_MS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const a = data.address || {};
    const houseNo = a.house_number || a.block || '';
    const street = a.road || a.pedestrian || a.footway || a.path || a.cycleway || a.street || '';
    const postcode = a.postcode || '';
    const building = (data.namedetails && data.namedetails.name) || data.name || a.building || '';

    const parts = [houseNo, street, building, 'SINGAPORE', postcode].filter(Boolean);
    const fullAddress = data.display_name || parts.join(' ').trim();

    return { address: fullAddress, houseNo, street, building, postcode };
  } catch (err) {
    console.warn('Reverse geocode (Nominatim) failed', err);
    return { address: '', houseNo: '', street: '', building: '', postcode: '' };
  }
}

// --- OneMap Search API for finding store locations ---
// Search for places by name using OneMap's search API
// OneMap search removed. Keeping a stub to avoid breaking references.
async function searchStoreLocation() { return null; }

// Helper function to calculate distance between two coordinates (Haversine formula)
function calculateDistance(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c; // Distance in kilometers
}
// ----------- Dictionary + spell-correction setup -----------
let englishWords = [];
async function loadDictionary() {
  try {
    const res = await fetch('https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt');
    const text = await res.text();
    englishWords = text.split('\n');
    console.log(`Dictionary loaded: ${englishWords.length} words`);
  } catch (err) {
    console.warn('Failed to load dictionary – spell correction disabled', err);
  }
}

loadDictionary();
// --- ChatGPT integration ---

function setOpenAIApiKey(key) {
  openaiApiKey = key;
  openaiClient = null; // reset so fresh client picks up new key
  if (key) {
    localStorage.setItem('openaiApiKey', key);
  } else {
    localStorage.removeItem('openaiApiKey');
  }
}

// OneMap API key handling removed

async function extractInfoGPT(rawText) {
  if (!openaiApiKey) return null;
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + openaiApiKey
      },
      body: JSON.stringify({
        model: 'gpt-3.5-turbo',
        temperature: 0,
        messages: [
          { role: 'system', content: 'You extract structured data from storefront OCR.' },
          { role: 'user', content: `Extract JSON with keys: storeName, unitNumber, address, category. For category, choose the most appropriate from: Art, Attractions, Auto, Beauty Services, Commercial Building, Education, Essentials, Financial, Food and Beverage, General Merchandise, Government Building, Healthcare, Home Services, Hotel, Industrial, Local Services, Mass Media, Nightlife, Physical Feature, Professional Services, Religious Organization, Residential, Sports and Fitness, Travel. Use "Not Found" if unknown. OCR: """${rawText}"""` }
        ]
      })
    });
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (err) {
    console.warn('ChatGPT parsing failed', err);
    return null;
  }
}

// Prompt user to set API key if not already stored
if (!openaiApiKey) {
  setTimeout(() => {
    if (confirm('Enter your OpenAI API key to enable ChatGPT parsing?')) {
      const key = prompt('OpenAI API key (sk-...)');
      if (key) setOpenAIApiKey(key.trim());
    }
  }, 500);
}

// OneMap API prompt removed

function correctStoreName(name) {
  if (!name || !englishWords.length || typeof didYouMean !== 'function') return name;

  // Break by whitespace / punctuation while preserving words
  const tokens = name.split(/(\s+)/); // keep spaces as tokens
  const corrected = tokens.map(tok => {
    if (/^\s+$/.test(tok)) return tok; // keep spaces
    const suggestion = didYouMean(tok.toLowerCase(), englishWords, { threshold: 0.4 });
    return suggestion ? capitalize(suggestion) : tok;
  });
  return corrected.join('');
}

function capitalize(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    video.srcObject = stream;
    window.currentCameraStream = stream;
    try {
      const track = stream.getVideoTracks && stream.getVideoTracks()[0];
      if (track) {
        enableAutofocus(track);
        initTrackZoom(track);
      }
    } catch (_) {}
    // After permission granted, enumerate to find ultra-wide if available
    detectAvailableCameras().catch(()=>{});
  } catch (err) {
    console.error(err);
    statusDiv.textContent = 'Camera access denied: ' + err.message;
  }
}

initCamera();

// --- Zoom functionality ---
const defaultZoom = 1.0;
let currentZoom = defaultZoom;
let minZoom = 0.5; // allow zooming out to 0.5x (fallback CSS)
let maxZoom = 5.0;
let zoomStep = 0.2;
// Hysteresis to avoid rapid lens switching around threshold
const lensSwitchLow = 0.55;  // switch to ultra only below this
const lensSwitchHigh = 0.65; // switch to wide only above this
let useTrackZoom = false; // prefer hardware zoom when supported
let trackCapabilities = null;

// Try to enable continuous autofocus when available
function enableAutofocus(track) {
  try {
    const caps = track.getCapabilities && track.getCapabilities();
    if (!caps) return;
    // Some browsers expose focusMode; try continuous or auto
    const modes = caps.focusMode || caps.focusModes || [];
    if (Array.isArray(modes)) {
      if (modes.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(()=>{});
      } else if (modes.includes('auto')) {
        track.applyConstraints({ advanced: [{ focusMode: 'auto' }] }).catch(()=>{});
      }
    }
  } catch (_) {}
}

// Prefer native camera zoom if supported by the track
function initTrackZoom(track) {
  try {
    const caps = track.getCapabilities && track.getCapabilities();
    if (caps && typeof caps.zoom === 'object' && typeof caps.zoom.min === 'number') {
      useTrackZoom = true;
      trackCapabilities = caps;
      // Align UI limits with hardware limits
      minZoom = typeof caps.zoom.min === 'number' ? caps.zoom.min : minZoom;
      maxZoom = typeof caps.zoom.max === 'number' ? caps.zoom.max : maxZoom;
      const range = Math.max(0.1, maxZoom - minZoom);
      zoomStep = Math.max(0.05, range / 20);
    }
  } catch (_) {}
}

// Tap-to-focus (best-effort). Uses pointsOfInterest when available.
video.addEventListener('click', (e) => {
  try {
    const stream = window.currentCameraStream;
    if (!stream) return;
    const track = stream.getVideoTracks && stream.getVideoTracks()[0];
    if (!track || !track.getCapabilities) return;
    const caps = track.getCapabilities();
    const rect = video.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;

    // Visual focus indicator
    showFocusRing(e.clientX, e.clientY);

    const advanced = [];
    if (caps.pointsOfInterest) {
      advanced.push({ pointsOfInterest: [{ x: Math.min(Math.max(x, 0), 1), y: Math.min(Math.max(y, 0), 1) }] });
    }
    const modes = caps.focusMode || [];
    if (Array.isArray(modes) && modes.includes('single-shot')) {
      advanced.push({ focusMode: 'single-shot' });
    }
    if (advanced.length) {
      track.applyConstraints({ advanced }).catch(()=>{});
    }
  } catch (_) {}
});

function showFocusRing(clientX, clientY) {
  try {
    const ring = document.createElement('div');
    ring.style.position = 'fixed';
    ring.style.left = (clientX - 30) + 'px';
    ring.style.top = (clientY - 30) + 'px';
    ring.style.width = '60px';
    ring.style.height = '60px';
    ring.style.border = '2px solid #00b14f';
    ring.style.borderRadius = '8px';
    ring.style.boxShadow = '0 0 8px rgba(0,0,0,0.25)';
    ring.style.pointerEvents = 'none';
    ring.style.zIndex = '9999';
    ring.style.transition = 'opacity 400ms ease, transform 400ms ease';
    document.body.appendChild(ring);
    requestAnimationFrame(() => {
      ring.style.transform = 'scale(0.9)';
      ring.style.opacity = '0.85';
    });
    setTimeout(() => {
      ring.style.opacity = '0';
      ring.style.transform = 'scale(1.1)';
      setTimeout(() => { if (ring.parentNode) ring.parentNode.removeChild(ring); }, 300);
    }, 500);
  } catch (_) {}
}

// Device-based zoom (switching physical lenses when available)
let cameraDevices = { wide: null, ultra: null };
let currentCameraType = 'wide';
let isSwitchingCamera = false;

async function detectAvailableCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter(d => d.kind === 'videoinput');
    const labelsKnown = videoInputs.some(d => d.label);
    // Try to infer wide from current track
    const currentTrack = (window.currentCameraStream && window.currentCameraStream.getVideoTracks()[0]) || null;
    if (currentTrack) {
      const settings = currentTrack.getSettings && currentTrack.getSettings();
      if (settings && settings.deviceId) cameraDevices.wide = settings.deviceId;
    }
    for (const d of videoInputs) {
      const label = (d.label || '').toLowerCase();
      if (!cameraDevices.wide) {
        // Prefer back/environment camera for wide
        if (label.includes('back') || label.includes('rear') || label.includes('environment')) {
          cameraDevices.wide = d.deviceId;
        }
      }
      if (!cameraDevices.ultra) {
        if (label.includes('ultra') || label.includes('ultra-wide') || /\b0\.5\b/.test(label) || label.includes('0.5')) {
          cameraDevices.ultra = d.deviceId;
        }
      }
    }
    // Fallback wide: first videoinput
    if (!cameraDevices.wide && videoInputs[0]) cameraDevices.wide = videoInputs[0].deviceId;
    return { ...cameraDevices, labelsKnown };
  } catch (e) {
    return cameraDevices;
  }
}

async function switchToCamera(type) {
  if (isSwitchingCamera) return;
  const targetId = type === 'ultra' ? cameraDevices.ultra : cameraDevices.wide;
  if (!targetId) return; // nothing to do
  try {
    isSwitchingCamera = true;
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: targetId } },
      audio: false
    });
    // Stop previous tracks
    const old = window.currentCameraStream;
    if (old) {
      old.getTracks().forEach(t => t.stop());
    }
    window.currentCameraStream = newStream;
    video.srcObject = newStream;
    currentCameraType = type;
    // When switching lens, reset CSS transform to 1 to reflect native FOV
    video.style.transform = 'scale(1)';
    zoomLevelSpan.textContent = type === 'ultra' ? '0.5x' : '1.0x';
  } catch (e) {
    // ignore failures
  } finally {
    isSwitchingCamera = false;
  }
}

// Zoom state management
function updateZoomLevel(newZoom) {
  currentZoom = Math.max(minZoom, Math.min(maxZoom, newZoom));

  // Prefer hardware zoom when supported
  const stream = window.currentCameraStream;
  const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  if (isZooming) {
    // During pinch gesture: avoid hardware constraints and lens switches; use CSS only
    const cssScale = currentCameraType === 'ultra' ? Math.max(1, currentZoom / 0.5) : currentZoom;
    video.style.transform = `scale(${cssScale})`;
    video.style.transformOrigin = 'center center';
  } else {
    if (useTrackZoom && track && track.applyConstraints) {
      track.applyConstraints({ advanced: [{ zoom: currentZoom }] }).catch(()=>{});
      video.style.transform = 'scale(1)';
    } else {
      // Device-based lens switch with hysteresis to prevent flapping
      if (currentZoom <= lensSwitchLow && currentCameraType !== 'ultra' && cameraDevices.ultra) {
        switchToCamera('ultra');
        currentZoom = 0.5;
      } else if (currentZoom >= lensSwitchHigh && currentCameraType !== 'wide' && cameraDevices.wide) {
        switchToCamera('wide');
        currentZoom = Math.max(1.0, currentZoom);
      }
      const cssScale = currentCameraType === 'ultra' ? Math.max(1, currentZoom / 0.5) : currentZoom;
      video.style.transform = `scale(${cssScale})`;
      video.style.transformOrigin = 'center center';
    }
  }
  
  // Update zoom level display
  zoomLevelSpan.textContent = `${currentZoom.toFixed(1)}x`;
  
  // Update button states
  zoomOutBtn.disabled = currentZoom <= minZoom;
  zoomInBtn.disabled = currentZoom >= maxZoom;
  
  // Show/hide reset button
  zoomResetBtn.style.opacity = currentZoom > minZoom ? '1' : '0.6';
}

// Zoom control event listeners
zoomInBtn.addEventListener('click', () => {
  updateZoomLevel(currentZoom + zoomStep);
});

zoomOutBtn.addEventListener('click', () => {
  updateZoomLevel(currentZoom - zoomStep);
});

zoomResetBtn.addEventListener('click', () => {
  updateZoomLevel(defaultZoom);
});

// Mouse wheel zoom for desktop
video.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? -zoomStep : zoomStep;
  updateZoomLevel(currentZoom + delta);
}, { passive: false });

// Touch gesture handling for mobile devices
let initialDistance = 0;
let initialZoom = 1.0;
let isZooming = false;

// Helper function to get distance between two touch points
function getDistance(touches) {
  if (touches.length < 2) return 0;
  const touch1 = touches[0];
  const touch2 = touches[1];
  return Math.sqrt(
    Math.pow(touch2.clientX - touch1.clientX, 2) + 
    Math.pow(touch2.clientY - touch1.clientY, 2)
  );
}

// Touch start - initialize pinch-to-zoom
video.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault();
    isZooming = true;
    initialDistance = getDistance(e.touches);
    initialZoom = currentZoom;
  }
}, { passive: false });

// Touch move - handle pinch-to-zoom
video.addEventListener('touchmove', (e) => {
  if (isZooming && e.touches.length === 2) {
    e.preventDefault();
    const currentDistance = getDistance(e.touches);
    
    if (initialDistance > 0) {
      const scale = currentDistance / initialDistance;
      const newZoom = initialZoom * scale;
      updateZoomLevel(newZoom);
    }
  }
}, { passive: false });

// Touch end - cleanup pinch-to-zoom
video.addEventListener('touchend', (e) => {
  if (e.touches.length < 2) {
    isZooming = false;
    initialDistance = 0;
    // Commit hardware zoom / lens switch after pinch ends
    updateZoomLevel(currentZoom);
  }
}, { passive: false });

// Keyboard shortcuts for zoom (optional enhancement)
document.addEventListener('keydown', (e) => {
  // Only handle zoom shortcuts when not typing in an input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  
  if (e.key === '+' || e.key === '=') {
    e.preventDefault();
    updateZoomLevel(currentZoom + zoomStep);
  } else if (e.key === '-' || e.key === '_') {
    e.preventDefault();
    updateZoomLevel(currentZoom - zoomStep);
  } else if (e.key === '0' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    updateZoomLevel(minZoom);
  }
});

// Initialize zoom controls
updateZoomLevel(currentZoom);

// --- Duplicate Detection Functions ---
function isDuplicateStore(newStore) {
  // Check if a store with the same name and address already exists
  return scans.some(existingStore => {
    // Normalize strings for comparison (trim whitespace, convert to lowercase)
    const existingName = (existingStore.storeName || '').trim().toLowerCase();
    const newName = (newStore.storeName || '').trim().toLowerCase();
    const existingAddress = (existingStore.address || '').trim().toLowerCase();
    const newAddress = (newStore.address || '').trim().toLowerCase();
    
    // Skip comparison if either name is "Not Found" or empty
    if (!existingName || !newName || existingName === 'not found' || newName === 'not found') {
      return false;
    }
    
    // Skip comparison if either address is "Not Found" or empty
    if (!existingAddress || !newAddress || existingAddress === 'not found' || newAddress === 'not found') {
      return false;
    }
    
    // Consider it a duplicate if both name and address match exactly
    const nameMatch = existingName === newName;
    const addressMatch = existingAddress === newAddress;
    
    return nameMatch && addressMatch;
  });
}

function showDuplicateDetected(storeName, address) {
  // Hide the scanning overlay first
  hideScanningOverlay();
  
  // Show duplicate detection overlay with custom styling
  if (scanningOverlay && scanningText) {
    scanningText.textContent = '⚠️ Duplicate Detected';
    scanningOverlay.classList.add('show', 'duplicate-warning');
    
    // Hide the spinner for duplicate warning
    const spinner = document.querySelector('.spinner');
    if (spinner) {
      spinner.style.display = 'none';
    }
    
    // Create detailed message
    const duplicateMessage = document.createElement('div');
    duplicateMessage.className = 'duplicate-message';
    duplicateMessage.innerHTML = `
      <div class="duplicate-details">
        <strong>${storeName}</strong><br>
        <small>${address}</small><br>
        <em>Already exists in your data</em>
      </div>
    `;
    
    // Add message to scanning content
    const scanningContent = document.querySelector('.scanning-content');
    if (scanningContent) {
      scanningContent.appendChild(duplicateMessage);
    }
    
    // Auto-hide after 3 seconds
    setTimeout(() => {
      scanningOverlay.classList.remove('show', 'duplicate-warning');
      if (duplicateMessage && duplicateMessage.parentNode) {
        duplicateMessage.parentNode.removeChild(duplicateMessage);
      }
      // Restore spinner visibility for next scan
      if (spinner) {
        spinner.style.display = 'block';
      }
    }, 3000);
  }
  
  // Also show in status div as backup
  statusDiv.textContent = `Duplicate detected: "${storeName}" already exists`;
  statusDiv.style.color = '#ff6b35';
  setTimeout(() => {
    statusDiv.textContent = '';
    statusDiv.style.color = '';
  }, 3000);
  
  console.log(`Duplicate store detected and rejected: "${storeName}" at "${address}"`);
}

// --- Helper: run OCR + processing on any canvas source (camera or uploaded) ---
async function performScanFromCanvas(canvas) {
  showScanningOverlay('Scanning...');
  statusDiv.textContent = 'Scanning…';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';

  const imageDataUrl = canvas.toDataURL('image/jpeg', 0.8);

  // Try Vision JSON extraction first
  let parsed = null;
  if (openaiApiKey) {
    showScanningOverlay('Analyzing...');
    statusDiv.textContent = 'Analyzing with GPT-4o…';
    parsed = await extractInfoVision(imageDataUrl);
    if (parsed) {
      console.log('Vision JSON:', parsed);
    }
  }

  // Try to get a quick location, but don't block scanning
  let geo = currentLocation;
  if (!geo.lat) {
    geo = await getCurrentLocation();
  }

  if (!parsed) {
    // Vision failed → run OCR fallback
    const result = await Tesseract.recognize(canvas, 'eng', {
      logger: m => {
        if (m.progress !== undefined) {
          const percent = Math.floor(m.progress * 100);
          statusDiv.textContent = `Scanning… ${percent}%`;
          progressFill.style.width = percent + '%';
        }
      },
      tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:#&-.',
      tessedit_pageseg_mode: 6
    });

    const { text, confidence, lines } = result.data;
    console.log('OCR confidence', confidence);

    showScanningOverlay('Processing text...');
    statusDiv.textContent = 'Processing…';

    parsed = await extractInfoGPT(text);
    if (!parsed) parsed = extractInfo(text, lines);
  }

  // Map extracted business type to canonical category (applies to Vision or OCR)
  if (parsed && parsed.category) {
    parsed.category = await mapToCompanyCategory(parsed.category);
  }

  // Reverse geocode based on current device location (Singapore)
  let finalLat, finalLng, addressParts;
  finalLat = geo.lat || '';
  finalLng = geo.lng || '';
  if (geo.lat && geo.lng) {
    try {
      addressParts = await reverseGeocode(geo.lat, geo.lng);
    } catch (_) { addressParts = { address: '', houseNo: '', street: '', building: '', postcode: '' }; }
  } else {
    addressParts = { address: parsed?.address || '', houseNo: '', street: '', building: '', postcode: '' };
  }

  // Store photo data with the scan
  const timestamp = new Date().toISOString();
  const photoId = `photo_${timestamp.replace(/[:.]/g, '-').slice(0, -5)}_${Math.random().toString(36).slice(2,8)}`;
  const photoFilename = `bnsVision_${parsed?.storeName || 'scan'}_${timestamp.replace(/[:.]/g, '-').slice(0, -5)}.jpg`;
  // Save full-resolution to IndexedDB; keep thumbnail in memory/localStorage
  const fullResBlob = await new Promise(resolve => { canvas.toBlob(resolve, 'image/jpeg', 0.9); });
  if (fullResBlob) {
    savePhotoBlob(photoId, fullResBlob, photoFilename);
  }
  const thumbDataUrl = createThumbnailDataURL(canvas, 400, 400, 0.6);

  const info = sanitizeObjectStrings(Object.assign(
    { 
      lat: finalLat, 
      lng: finalLng, 
      address: addressParts?.address || parsed?.address || '',
      houseNo: addressParts?.houseNo || parsed?.houseNo || '',
      street: addressParts?.street || parsed?.street || '',
      building: addressParts?.building || parsed?.building || '',
      postcode: addressParts?.postcode || parsed?.postcode || '',
      photoData: thumbDataUrl,
      timestamp: timestamp,
      photoFilename: photoFilename,
      photoId: photoId
    },
    parsed
  ));

  // Check for duplicates before adding
  if (isDuplicateStore(info)) {
    // Show duplicate detection message
    showDuplicateDetected(info.storeName, info.address);
    statusDiv.textContent = '';
    progressBar.style.display = 'none';
    return; // Don't add duplicate
  }

  // Insert newest scan at the top
  scans.unshift(info);
  // Keep array sorted by newest-first as a safety net
  sortScansNewestFirst();
  saveScans();
  renderTable();
  
  // Show completion message
  showScanComplete();
  
  statusDiv.textContent = '';
  progressBar.style.display = 'none';
}

// Helper function to capture and save photo to gallery
async function captureAndSavePhoto(canvas) {
  try {
    // Visual feedback only; no auto share or download
    showPhotoFlash();
    return true;
  } catch (error) {
    console.error('Error saving photo:', error);
    return false;
  }
}

// Helper function to show photo saved notification
function showPhotoSavedNotification(message = '📸 Photo saved to gallery', isError = false) {
  // Create notification element
  const notification = document.createElement('div');
  
  const backgroundColor = isError ? 'rgba(220, 38, 38, 0.95)' : 'rgba(0, 177, 79, 0.95)';
  
  notification.style.cssText = `
    position: fixed;
    top: 80px;
    left: 50%;
    transform: translateX(-50%);
    background: ${backgroundColor};
    color: white;
    padding: 12px 20px;
    border-radius: 25px;
    font-size: 14px;
    font-weight: 500;
    z-index: 9998;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    animation: slideInOut 4s ease-in-out;
    pointer-events: none;
    backdrop-filter: blur(10px);
    max-width: 280px;
    text-align: center;
  `;
  
  notification.innerHTML = message;
  
  // Add slide animation CSS if not already present
  if (!document.querySelector('#photoNotificationStyle')) {
    const style = document.createElement('style');
    style.id = 'photoNotificationStyle';
    style.textContent = `
      @keyframes slideInOut {
        0% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
        12% { opacity: 1; transform: translateX(-50%) translateY(0); }
        88% { opacity: 1; transform: translateX(-50%) translateY(0); }
        100% { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(notification);
  
  // Remove notification after animation
  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 4000);
}

// Helper function to show photo capture flash effect
function showPhotoFlash() {
  // Create flash overlay
  const flashOverlay = document.createElement('div');
  flashOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: white;
    z-index: 9999;
    pointer-events: none;
    animation: photoFlash 0.3s ease-out;
  `;
  
  // Add flash animation CSS if not already present
  if (!document.querySelector('#photoFlashStyle')) {
    const style = document.createElement('style');
    style.id = 'photoFlashStyle';
    style.textContent = `
      @keyframes photoFlash {
        0% { opacity: 0; }
        50% { opacity: 0.8; }
        100% { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }
  
  document.body.appendChild(flashOverlay);
  
  // Remove flash overlay after animation
  setTimeout(() => {
    if (flashOverlay.parentNode) {
      flashOverlay.parentNode.removeChild(flashOverlay);
    }
  }, 300);
}

// Scan button handler
document.getElementById('scanBtn').addEventListener('click', async () => {
  if (!video.videoWidth) {
    statusDiv.textContent = 'Camera not ready yet, please wait…';
    return;
  }

  showScanningOverlay('Capturing image...');
  statusDiv.textContent = 'Scanning…';
  progressBar.style.display = 'block';
  progressFill.style.width = '0%';

  // Capture current frame
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Check if photo capture is enabled (default: true)
  const photoCaptureEnabled = localStorage.getItem('photoCaptureEnabled') !== 'false';
  
  if (photoCaptureEnabled) {
    // Capture and save photo to gallery (parallel with scanning)
    const photoSaved = await captureAndSavePhoto(canvas);
    
    if (photoSaved) {
      console.log('✅ Photo captured and saved to gallery');
    } else {
      console.warn('⚠️ Failed to save photo to gallery');
    }
  } else {
    console.log('📸 Photo capture disabled by user');
  }

  // Continue with normal scanning process
  await performScanFromCanvas(canvas);
});

// Upload image handler
if (uploadBtn && imageInput) {
  uploadBtn.addEventListener('click', () => imageInput.click());

  imageInput.addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    const img = new Image();
    img.onload = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      
      // Check if photo capture is enabled for uploaded images too
      const photoCaptureEnabled = localStorage.getItem('photoCaptureEnabled') !== 'false';
      
      if (photoCaptureEnabled) {
        // Capture and save photo to gallery for uploaded images too
        const photoSaved = await captureAndSavePhoto(canvas);
        
        if (photoSaved) {
          console.log('✅ Uploaded photo processed and saved to gallery');
        } else {
          console.warn('⚠️ Failed to save uploaded photo to gallery');
        }
      }
      
      await performScanFromCanvas(canvas);
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
    imageInput.value = '';
  });
}

// Extract structured information from raw OCR text
function extractInfo(rawText, ocrLines = []) {
  // Normalise whitespace
  const text = rawText.replace(/\n+/g, '\n').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // ----- Patterns based on rules provided -----
  // Pick store name using multiple heuristics
  let storeName = '';
  if (ocrLines.length) {
    // Step 1: Filter lines with mostly letters (reduce gibberish)
    const letterLines = ocrLines.filter(l => {
      const txt = l.text.trim();
      const letters = txt.replace(/[^A-Za-z]/g, '');
      const ratio = letters.length / (txt.length || 1);
      return letters.length >= 3 && ratio > 0.6; // at least 60% letters
    });

    // Step 2: Choose line with highest confidence ( then longest length )
    letterLines.sort((a, b) => (b.confidence || b.conf || 0) - (a.confidence || a.conf || 0));
    if (letterLines.length) {
      storeName = letterLines[0].text.trim();
    }
  }

  // 2) Fallback: first line that is mostly uppercase (e.g., "SCAN ME")
  if (!storeName) {
    const upperCandidate = lines.find(l => {
      const letters = l.replace(/[^A-Za-z]/g, '');
      return letters.length >= 3 && letters === letters.toUpperCase();
    });
    if (upperCandidate) storeName = upperCandidate;
  }

  // 3) Ultimate fallback: first line
  if (!storeName) storeName = lines[0] || '';

  storeName = correctStoreName(storeName);

  // Unit number must be in the form #XX-XXX
  const unitMatch = text.match(/#\d{2}-\d{3}/);
  let unitNumber = unitMatch ? unitMatch[0] : '';

  // Singapore phone number: 65 XXXX XXXX, with optional '+' and optional spaces
  const phoneMatch = text.match(/\+?65\s?\d{4}\s?\d{4}/);
  let phone = phoneMatch ? phoneMatch[0] : '';
  if (phone) {
    phone = phone.replace(/\s+/g, ' '); // normalise spacing
  }

  // Website: detect domain like example.com (with or without protocol)
  const websiteMatch = text.match(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  let website = websiteMatch ? websiteMatch[0].replace(/^[^A-Za-z]+/, '') : '';

  // Opening hours: XX:XX - XX:XX (24-hour) with optional spaces
  const openingHoursMatch = text.match(/(?:[01]?\d|2[0-3]):[0-5]\d\s*[-–]\s*(?:[01]?\d|2[0-3]):[0-5]\d/);
  let openingHours = openingHoursMatch ? openingHoursMatch[0].replace(/\s+/g, ' ') : '';

  // Guess business category based on keywords using the official categories
  const categories = {
    // Food and Beverage
    'restaurant|cafe|café|bakery|food|dining|kitchen|bistro|eatery|bar|pub|fast food|takeaway|delivery': 'Food and Beverage',
    
    // Beauty Services
    'salon|spa|hair|beauty|nail|barber|massage|facial|cosmetic|makeup': 'Beauty Services',
    
    // Healthcare
    'clinic|medical|dental|pharmacy|hospital|doctor|dentist|physiotherapy|optometry': 'Healthcare',
    
    // General Merchandise / Retail
    'shop|store|retail|mart|supermarket|grocery|convenience|book|stationery|gift|toy|clothing|fashion': 'General Merchandise',
    
    // Sports and Fitness
    'gym|fitness|yoga|sport|exercise|training|martial arts|pilates|swimming': 'Sports and Fitness',
    
    // Auto
    'car|auto|mechanic|garage|petrol|gas|workshop|tire|automotive|vehicle': 'Auto',
    
    // Financial
    'bank|atm|insurance|finance|loan|money|exchange|investment|accounting': 'Financial',
    
    // Education
    'school|education|tuition|learning|academy|institute|college|university|kindergarten': 'Education',
    
    // Hotel
    'hotel|motel|inn|lodge|accommodation|hostel|resort|guesthouse': 'Hotel',
    
    // Professional Services
    'law|lawyer|legal|consultant|office|service|agency|firm|real estate': 'Professional Services',
    
    // Home Services
    'plumber|electrician|cleaning|repair|maintenance|contractor|handyman|renovation': 'Home Services',
    
    // Local Services
    'laundry|dry clean|tailor|key|locksmith|photo|printing|courier|postal': 'Local Services',
    
    // Art
    'art|gallery|studio|craft|design|creative|painting|sculpture|exhibition': 'Art',
    
    // Attractions
    'museum|zoo|park|attraction|tourist|sightseeing|entertainment|cinema|theater': 'Attractions',
    
    // Essentials
    'pharmacy|convenience|grocery|supermarket|essential|daily|necessities': 'Essentials',
    
    // Government Building
    'government|municipal|council|office|public|administration|ministry|department': 'Government Building',
    
    // Mass Media
    'media|newspaper|radio|tv|broadcasting|news|publication|printing press': 'Mass Media',
    
    // Nightlife
    'club|nightclub|lounge|disco|karaoke|ktv|night|entertainment|party': 'Nightlife',
    
    // Religious Organization
    'church|temple|mosque|synagogue|religious|worship|prayer|spiritual': 'Religious Organization',
    
    // Travel
    'travel|tour|airline|booking|ticket|vacation|holiday|cruise|flight': 'Travel',
    
    // Commercial Building
    'office|building|commercial|business|corporate|headquarters|plaza|center': 'Commercial Building',
    
    // Industrial
    'factory|warehouse|industrial|manufacturing|production|plant|facility': 'Industrial',
    
    // Residential
    'apartment|condo|residential|housing|home|villa|townhouse|flat': 'Residential'
  };

  let category = 'Unknown';
  for (const pattern in categories) {
    if (new RegExp(pattern, 'i').test(text)) {
      category = categories[pattern];
      break;
    }
  }

  // Use "Not Found" when a field could not be extracted to match strict rules
  if (!storeName) storeName = '';
  if (!unitNumber) unitNumber = '';
  if (!openingHours) openingHours = ''; // kept for future reference
  if (!phone) phone = '';              // kept for future reference
  if (!website) website = '';          // kept for future reference

  // Placeholder – address extraction will be implemented later or via geocoding
  let address = '';

  if (!address) address = '';

  return {
    storeName,
    unitNumber,
    address,
    category,
    rawText: text
  };
}

// --- Company category mapping ---
let companyCategories = [];

async function loadCompanyCategories() {
  if (companyCategories.length) return companyCategories;
  try {
    // First try pre-generated JSON (faster)
    const jsonRes = await fetch('categories.json');
    if (jsonRes.ok) {
      companyCategories = (await jsonRes.json()).map(cat => ({
        key: cat.key,
        name: (cat.name || '').toLowerCase(),
        last: (cat.key.split('::').filter(Boolean).pop() || '').toLowerCase()
      }));
      console.log(`Loaded ${companyCategories.length} categories from JSON`);
      return companyCategories;
    }
  } catch (_) {
    /* fallthrough to CSV */
  }

  try {
    // Fallback to CSV shipped alongside the app if JSON unavailable
    const csvPath = encodeURI('Geo Places - Final POI Category Tree - Q2 2024 - 2. Category Tree.csv');
    const res = await fetch(csvPath);
    const csvText = await res.text();
    const lines = csvText.split(/\r?\n/);
    lines.shift(); // drop header
    const splitter = /,(?=(?:[^"]*\"[^"]*\")*[^\"]*$)/;
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split(splitter);
      const name = (cols[3] || '').replace(/^"|"$/g, '').trim();
      const keyRaw = (cols[5] || '').replace(/^"|"$/g, '').trim();
      if (!keyRaw) continue;
      const key = keyRaw.replace(/:+$/, '');
      const lastSegment = key.split('::').filter(Boolean).pop() || '';
      companyCategories.push({ key, name: name.toLowerCase(), last: lastSegment.toLowerCase() });
    }
    console.log(`Parsed ${companyCategories.length} categories from CSV`);
  } catch (err) {
    console.warn('Failed to load categories from CSV', err);
  }
  return companyCategories;
}

async function mapToCompanyCategory(inputCategory = '') {
  if (!inputCategory || inputCategory === 'Unknown' || inputCategory === 'Not Found') {
    return inputCategory;
  }

  // Define the official business categories
  const officialCategories = [
    'Art', 'Attractions', 'Auto', 'Beauty Services', 'Commercial Building',
    'Education', 'Essentials', 'Financial', 'Food and Beverage', 'General Merchandise',
    'Government Building', 'Healthcare', 'Home Services', 'Hotel', 'Industrial',
    'Local Services', 'Mass Media', 'Nightlife', 'Physical Feature',
    'Professional Services', 'Religious Organization', 'Residential',
    'Sports and Fitness', 'Travel'
  ];

  const query = inputCategory.toLowerCase().trim();
  
  // Direct match first (case-insensitive)
  let directMatch = officialCategories.find(cat => cat.toLowerCase() === query);
  if (directMatch) {
    console.log(`Direct match: ${inputCategory} → ${directMatch}`);
    return directMatch;
  }

  // Mapping for common variations and synonyms
  const categoryMappings = {
    // Food and Beverage variations
    'f&b': 'Food and Beverage',
    'food': 'Food and Beverage',
    'restaurant': 'Food and Beverage',
    'dining': 'Food and Beverage',
    'cafe': 'Food and Beverage',
    'bakery': 'Food and Beverage',
    'eatery': 'Food and Beverage',
    
    // Beauty variations
    'beauty': 'Beauty Services',
    'salon': 'Beauty Services',
    'spa': 'Beauty Services',
    'barber': 'Beauty Services',
    
    // Retail variations
    'retail': 'General Merchandise',
    'shop': 'General Merchandise',
    'store': 'General Merchandise',
    'merchandise': 'General Merchandise',
    'mart': 'General Merchandise',
    
    // Fitness variations
    'fitness': 'Sports and Fitness',
    'gym': 'Sports and Fitness',
    'sport': 'Sports and Fitness',
    'exercise': 'Sports and Fitness',
    
    // Medical variations
    'medical': 'Healthcare',
    'clinic': 'Healthcare',
    'hospital': 'Healthcare',
    'pharmacy': 'Healthcare',
    
    // Other common variations
    'automotive': 'Auto',
    'car': 'Auto',
    'vehicle': 'Auto',
    'finance': 'Financial',
    'bank': 'Financial',
    'school': 'Education',
    'learning': 'Education',
    'accommodation': 'Hotel',
    'lodging': 'Hotel',
    'office': 'Commercial Building',
    'building': 'Commercial Building'
  };

  // Check for mapping variations
  let mappedCategory = categoryMappings[query];
  if (mappedCategory) {
    console.log(`Mapped variation: ${inputCategory} → ${mappedCategory}`);
    return mappedCategory;
  }

  // Partial matching - if input contains any official category name
  for (const category of officialCategories) {
    if (query.includes(category.toLowerCase()) || category.toLowerCase().includes(query)) {
      console.log(`Partial match: ${inputCategory} → ${category}`);
      return category;
    }
  }

  console.log(`No match found for: ${inputCategory}, keeping original`);
  return inputCategory;
}

// ===== MAP FUNCTIONALITY =====
let miniMap = null;
let fullMap = null;
let userLocationMarker = null;
let userAccuracyCircle = null;
let routePoints = [];
let routeLine = null;
let teamMarkers = [];
let followUserLocation = true;
let lastUserLocation = null;
let annotationLayer = null; // FeatureGroup for drawn items
let drawControl = null;
const ANNOTATIONS_KEY = 'bnsv_annotations_geojson_v1';
let addRoutePointMode = false;
let currentMarkerStyle = 'cross'; // 'cross' | 'dot' | 'circle'

function loadAnnotations() {
  try {
    const json = localStorage.getItem(ANNOTATIONS_KEY);
    if (!json) return null;
    return JSON.parse(json);
  } catch (_) {
    return null;
  }
}

function saveAnnotations() {
  if (!annotationLayer) return;
  const geojson = annotationLayer.toGeoJSON();
  localStorage.setItem(ANNOTATIONS_KEY, JSON.stringify(geojson));
}

// Initialize maps with fallback tile sources
function initializeMaps() {
  console.log('Initializing maps...');
  
  // Check if Leaflet is loaded
  if (typeof L === 'undefined') {
    console.error('Leaflet library not loaded');
    setTimeout(initializeMaps, 2000); // Retry after 2 seconds
    return;
  }
  
  // Check if map containers exist
  const miniMapContainer = document.getElementById('miniMap');
  const fullMapContainer = document.getElementById('fullMap');
  
  if (!miniMapContainer) {
    console.error('Mini map container not found');
    return;
  }
  
  if (!fullMapContainer) {
    console.error('Full map container not found');
    return;
  }
  
  console.log('Map containers found, Leaflet loaded');
  
  // Initialize mini map
  if (!miniMap) {
    try {
      miniMap = L.map('miniMap', {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false
      }).setView([1.3521, 103.8198], 12); // Singapore center

      // Add tile layers with fallback
      addTileLayersToMap(miniMap);
      console.log('Mini map initialized successfully');
      
    } catch (error) {
      console.error('Error initializing mini map:', error);
      // Show error in UI
      const mapStatus = document.getElementById('mapStatus');
      if (mapStatus) mapStatus.textContent = '🗺️ Map loading error';
    }
  }

  // Initialize full map
  if (!fullMap) {
    try {
      fullMap = L.map('fullMap', {
        zoomControl: true,
        attributionControl: true,
        doubleClickZoom: false,
        tap: false
      }).setView([1.3521, 103.8198], 12);

      // Add tile layers with fallback
      addTileLayersToMap(fullMap);
      console.log('Full map initialized successfully');

      // Click-to-add route points is gated by explicit mode to avoid interference with drawing tools
      fullMap.on('click', function(e) {
        if (addRoutePointMode) {
          addRoutePoint(e.latlng);
        }
      });

      // Initialize annotations layer and controls
      annotationLayer = new L.FeatureGroup();
      fullMap.addLayer(annotationLayer);
      try {
        drawControl = new L.Control.Draw({
          position: 'topright',
          draw: {
            polyline: { shapeOptions: { color: '#ff9800', weight: 3 }, touchExtend: true, repeatMode: true, maxPoints: 1000 },
            polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#e91e63', weight: 2, fillOpacity: 0.1 } },
            rectangle: { shapeOptions: { color: '#3f51b5', weight: 2, fillOpacity: 0.1 } },
            circle: false,
            circlemarker: false,
            marker: { icon: createMarkerIcon('pending', currentMarkerStyle), repeatMode: true }
          },
          edit: {
            featureGroup: annotationLayer,
            remove: true
          }
        });
        fullMap.addControl(drawControl);
      } catch (e) {
        console.warn('Leaflet.Draw not available');
      }
      // While drawing, disable map gestures and suppress double-tap finish on iOS
      fullMap.on('draw:drawstart', function(e) {
        try {
          fullMap.dragging.disable();
          fullMap.boxZoom.disable();
        } catch(_){}
        // Monkey patch: force Polyline handler to not finish on dblclick
        try {
          const handler = e && e.layer ? e.layer : null;
        } catch(_){}
      });
      fullMap.on('draw:drawstop', function() { try { fullMap.dragging.enable(); fullMap.boxZoom.enable(); } catch(_){} });
      fullMap.on('dblclick', function(e){ if (e && e.originalEvent) e.originalEvent.preventDefault(); L.DomEvent.stop(e); });
      const fullMapEl = document.getElementById('fullMap');
      if (fullMapEl) {
        fullMapEl.addEventListener('dblclick', function(e){ e.preventDefault(); e.stopPropagation(); }, true);
      }

      // Restore saved annotations
      const saved = loadAnnotations();
      if (saved && saved.type === 'FeatureCollection') {
        L.geoJSON(saved, {
          pointToLayer: function(feature, latlng) {
            const status = feature.properties && feature.properties.status || 'pending';
            const style = feature.properties && feature.properties.markerStyle || currentMarkerStyle;
            return L.marker(latlng, { icon: createMarkerIcon(status, style) });
          },
          style: function(feature) {
            return feature.properties && feature.properties._style || {};
          },
          onEachFeature: function(feature, layer) {
            attachAnnotationHandlers(layer, feature.properties || {});
          }
        }).eachLayer(l => annotationLayer.addLayer(l));
      }

      // Handle creation/edit/delete
      fullMap.on(L.Draw.Event.CREATED, function (evt) {
        const layer = evt.layer;
        // Default properties
        layer.feature = layer.feature || { type: 'Feature', properties: {} };
        if (layer instanceof L.Marker) {
          layer.feature.properties.status = 'pending';
          layer.feature.properties.markerStyle = currentMarkerStyle;
          // Force the icon to match current selection immediately
          try { layer.setIcon(createMarkerIcon('pending', currentMarkerStyle)); } catch(_) {}
        }
        attachAnnotationHandlers(layer, layer.feature.properties);
        annotationLayer.addLayer(layer);
        saveAnnotations();
      });

      fullMap.on(L.Draw.Event.EDITED, function () {
        saveAnnotations();
      });
      fullMap.on(L.Draw.Event.DELETED, function () {
        saveAnnotations();
      });
      
    } catch (error) {
      console.error('Error initializing full map:', error);
    }
  }
  
  // Add interaction handlers after both maps are initialized
  setTimeout(() => {
    addMapInteractionHandlers();
  }, 500);
}
// Minimize/expand mini map
const toggleMiniMapBtn = document.getElementById('toggleMiniMapBtn');
if (toggleMiniMapBtn) {
  toggleMiniMapBtn.addEventListener('click', () => {
    const miniMapEl = document.getElementById('miniMap');
    if (!miniMapEl) return;
    const minimized = miniMapEl.classList.toggle('minimized');
    toggleMiniMapBtn.textContent = minimized ? '▸' : '▾';
  });
}

// Add tile layers with multiple fallback sources
function addTileLayersToMap(map) {
  // Use OpenStreetMap directly
  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
    errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  });
  osmLayer.addTo(map);

  // Mark map as loaded when tiles load successfully
  osmLayer.on('load', function() {
    const mapContainer = map.getContainer();
    if (mapContainer) {
      mapContainer.classList.add('loaded');
    }
  });

  // Force map to refresh and invalidate size
  setTimeout(() => { map.invalidateSize(); }, 100);
  setTimeout(() => { map.invalidateSize(); }, 500);
  setTimeout(() => { map.invalidateSize(); }, 1000);
}

// Update user location on both maps with smooth tracking
function updateUserLocation(lat, lng, heading = null, accuracy = null) {
  const location = [lat, lng];
  const isFirstLocation = !lastUserLocation;
  lastUserLocation = { lat, lng };

  // Create Google Maps style blue dot with accuracy circle
  if (userLocationMarker) {
    // Smooth animation to new position
    userLocationMarker.setLatLng(location);
    
    // Update heading if available
    if (heading !== null) {
      const markerElement = userLocationMarker.getElement();
      if (markerElement) {
        const dot = markerElement.querySelector('.user-dot');
        if (dot) {
          dot.style.transform = `rotate(${heading}deg)`;
        }
      }
    }
  } else {
    // Create blue location dot similar to Google Maps
    const userIcon = L.divIcon({
      className: 'user-location-marker',
      html: `
        <div class="user-location-container">
          <div class="user-dot-pulse"></div>
          <div class="user-dot" style="transform: rotate(${heading || 0}deg);">
            <div class="user-dot-inner"></div>
            <div class="user-dot-direction"></div>
          </div>
        </div>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });

    userLocationMarker = L.marker(location, { icon: userIcon });
    
    // Add to mini map
    if (miniMap) {
      userLocationMarker.addTo(miniMap);
    }
    
    // Add to full map only if it exists and is currently visible
    if (fullMap) {
      userLocationMarker.addTo(fullMap);
    }
  }

  // Update accuracy circle
  if (accuracy && accuracy < 100) { // Only show if accuracy is reasonable
    if (userAccuracyCircle) {
      userAccuracyCircle.setLatLng(location);
      userAccuracyCircle.setRadius(accuracy);
    } else {
      userAccuracyCircle = L.circle(location, {
        radius: accuracy,
        color: '#4285f4',
        fillColor: '#4285f4',
        fillOpacity: 0.1,
        weight: 1,
        opacity: 0.3
      });
      
      // Add to mini map
      if (miniMap) {
        userAccuracyCircle.addTo(miniMap);
      }
      
      // Add to full map if it exists
      if (fullMap) {
        userAccuracyCircle.addTo(fullMap);
      }
    }
  }

  // Follow user location (like Google Maps)
  if (followUserLocation) {
    const zoomLevel = isFirstLocation ? 16 : null; // Zoom in on first location, maintain zoom after
    
    // Smooth pan to user location on mini map
    if (miniMap) {
      if (zoomLevel) {
        miniMap.setView(location, zoomLevel, { animate: true, duration: 1.0 });
      } else {
        miniMap.panTo(location, { animate: true, duration: 0.5 });
      }
    }
    
    // Also update full map if it's open
    if (fullMap && !document.getElementById('fullMapOverlay').classList.contains('hidden')) {
      if (zoomLevel) {
        fullMap.setView(location, zoomLevel, { animate: true, duration: 1.0 });
      } else {
        fullMap.panTo(location, { animate: true, duration: 0.5 });
      }
    }
  }

  // Update status
  const mapStatus = document.getElementById('mapStatus');
  if (mapStatus) {
    const accuracyText = accuracy ? ` (±${Math.round(accuracy)}m)` : '';
    mapStatus.textContent = `📍 Location tracking${accuracyText}`;
  }
}

// Add route point for planning
function addRoutePoint(latlng) {
  const point = {
    lat: latlng.lat,
    lng: latlng.lng,
    id: Date.now(),
    marker: null
  };

  // Create marker
  const marker = L.marker([point.lat, point.lng], {
    draggable: true
  }).addTo(fullMap);

  marker.bindPopup(`Point ${routePoints.length + 1}<br><button onclick="removeRoutePoint(${point.id})">Remove</button>`);
  
  // Update marker position when dragged
  marker.on('dragend', function() {
    const pos = marker.getLatLng();
    point.lat = pos.lat;
    point.lng = pos.lng;
    updateRouteDisplay();
  });

  point.marker = marker;
  routePoints.push(point);
  
  updateRouteDisplay();
}

// Remove route point
function removeRoutePoint(pointId) {
  const index = routePoints.findIndex(p => p.id === pointId);
  if (index !== -1) {
    const point = routePoints[index];
    if (point.marker) {
      fullMap.removeLayer(point.marker);
    }
    routePoints.splice(index, 1);
    updateRouteDisplay();
  }
}

// Update route line and stats
function updateRouteDisplay() {
  // Remove existing route line
  if (routeLine) {
    fullMap.removeLayer(routeLine);
    routeLine = null;
  }

  if (routePoints.length > 1) {
    // Create route line
    const latlngs = routePoints.map(p => [p.lat, p.lng]);
    routeLine = L.polyline(latlngs, {
      color: '#00b14f',
      weight: 4,
      opacity: 0.7
    }).addTo(fullMap);

    // Calculate route statistics
    let totalDistance = 0;
    for (let i = 0; i < routePoints.length - 1; i++) {
      const p1 = routePoints[i];
      const p2 = routePoints[i + 1];
      totalDistance += getDistance(p1.lat, p1.lng, p2.lat, p2.lng);
    }

    // Update UI
    const routeDistance = document.getElementById('routeDistance');
    const routeTime = document.getElementById('routeTime');
    const routePointsEl = document.getElementById('routePoints');

    if (routeDistance) routeDistance.textContent = `Distance: ${totalDistance.toFixed(1)} km`;
    if (routeTime) routeTime.textContent = `Time: ${Math.ceil(totalDistance * 12)} min`; // 5 km/h walking speed
    if (routePointsEl) routePointsEl.textContent = `Points: ${routePoints.length}`;

    // Update route progress
    const routeProgress = document.getElementById('routeProgress');
    if (routeProgress) {
      routeProgress.textContent = `${routePoints.length} stops planned`;
    }
  } else {
    // Clear stats
    const routeDistance = document.getElementById('routeDistance');
    const routeTime = document.getElementById('routeTime');
    const routePointsEl = document.getElementById('routePoints');
    const routeProgress = document.getElementById('routeProgress');

    if (routeDistance) routeDistance.textContent = 'Distance: 0 km';
    if (routeTime) routeTime.textContent = 'Time: 0 min';
    if (routePointsEl) routePointsEl.textContent = 'Points: 0';
    if (routeProgress) routeProgress.textContent = '';
  }
}

// Optimize route using nearest neighbor algorithm
function optimizeRoute() {
  if (routePoints.length < 3) return;

  // Get user location as starting point
  let currentLat = currentLocation.lat;
  let currentLng = currentLocation.lng;

  if (!currentLat || !currentLng) {
    alert('Current location not available for optimization');
    return;
  }

  const optimized = [];
  const remaining = [...routePoints];

  // Start from current location
  while (remaining.length > 0) {
    let nearestIndex = 0;
    let nearestDistance = Infinity;

    // Find nearest unvisited point
    for (let i = 0; i < remaining.length; i++) {
      const distance = getDistance(currentLat, currentLng, remaining[i].lat, remaining[i].lng);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }

    // Move to optimized array
    const nearest = remaining.splice(nearestIndex, 1)[0];
    optimized.push(nearest);
    currentLat = nearest.lat;
    currentLng = nearest.lng;
  }

  // Update route points array
  routePoints = optimized;
  
  // Update markers popup text
  routePoints.forEach((point, index) => {
    if (point.marker) {
      point.marker.bindPopup(`Point ${index + 1}<br><button onclick="removeRoutePoint(${point.id})">Remove</button>`);
    }
  });

  updateRouteDisplay();
  
  alert(`Route optimized! Total distance: ${document.getElementById('routeDistance').textContent.split(': ')[1]}`);
}

// Clear all route points
function clearRoute() {
  routePoints.forEach(point => {
    if (point.marker) {
      fullMap.removeLayer(point.marker);
    }
  });
  routePoints = [];
  updateRouteDisplay();
}

// Map UI event handlers
document.addEventListener('DOMContentLoaded', function() {
  // Show loading indicator
  const mapStatus = document.getElementById('mapStatus');
  if (mapStatus) mapStatus.textContent = '🗺️ Loading maps...';
  
  // Initialize maps when page loads with longer delay for mobile
  setTimeout(initializeMaps, 1000);
  
  // Also try to initialize after Leaflet is fully loaded
  if (typeof L !== 'undefined') {
    setTimeout(initializeMaps, 1500);
  }

  // Map expand button
  const mapExpandBtn = document.getElementById('mapExpandBtn');
  const fullMapOverlay = document.getElementById('fullMapOverlay');
  const mapCloseBtn = document.getElementById('mapCloseBtn');
  const requestLocationBtn = document.getElementById('requestLocationBtn');
  const followLocationBtn = document.getElementById('followLocationBtn');

  if (mapExpandBtn && fullMapOverlay) {
    mapExpandBtn.addEventListener('click', function() {
      console.log('Opening full map overlay');
      fullMapOverlay.classList.remove('hidden');
      
      // Force scroll to top and lock body scrolling
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      
      // Invalidate size after animation
      setTimeout(() => {
        if (fullMap) {
          fullMap.invalidateSize();
          // Ensure user location is visible on full map
          syncUserLocationToFullMap();
        }
        
        // Debug: Check if close button is visible
        const closeBtn = document.getElementById('mapCloseBtn');
        if (closeBtn) {
          const rect = closeBtn.getBoundingClientRect();
          console.log('Close button position:', {
            top: rect.top,
            right: rect.right,
            width: rect.width,
            height: rect.height,
            visible: rect.width > 0 && rect.height > 0
          });
        }
      }, 300);
    });
  }

  if (mapCloseBtn && fullMapOverlay) {
    mapCloseBtn.addEventListener('click', function(e) {
      console.log('Close button clicked');
      e.preventDefault();
      e.stopPropagation();
      fullMapOverlay.classList.add('hidden');
      
      // Restore body scrolling
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    });
    
    // Also add touch event for mobile
    mapCloseBtn.addEventListener('touchend', function(e) {
      console.log('Close button touched');
      e.preventDefault();
      e.stopPropagation();
      fullMapOverlay.classList.add('hidden');
      
      // Restore body scrolling
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    });
    
    console.log('Map close button event listeners added');
  } else {
    console.error('Map close button or overlay not found:', { mapCloseBtn, fullMapOverlay });
  }

  // Photo capture toggle removed

  // Add backup close methods
  if (fullMapOverlay) {
    // Close on overlay background click
    fullMapOverlay.addEventListener('click', function(e) {
      if (e.target === fullMapOverlay) {
        console.log('Overlay background clicked');
        fullMapOverlay.classList.add('hidden');
      }
    });
    
    // Close on escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape' && !fullMapOverlay.classList.contains('hidden')) {
        console.log('Escape key pressed');
        fullMapOverlay.classList.add('hidden');
      }
    });
  }

  // Route control buttons
  const clearRouteBtn = document.getElementById('clearRouteBtn');
  const optimizeRouteBtn = document.getElementById('optimizeRouteBtn');
  const centerOnUserBtn = document.getElementById('centerOnUserBtn');
  const addRoutePointModeBtn = document.getElementById('addRoutePointModeBtn');
  const markerStyleBtn = document.getElementById('markerStyleBtn');

  if (clearRouteBtn) {
    clearRouteBtn.addEventListener('click', clearRoute);
  }

  if (optimizeRouteBtn) {
    optimizeRouteBtn.addEventListener('click', optimizeRoute);
  }

  if (centerOnUserBtn) {
    centerOnUserBtn.addEventListener('click', function() {
      if (lastUserLocation && fullMap) {
        // Ensure user location markers are on the full map
        syncUserLocationToFullMap();
        
        // Center on user location with appropriate zoom
        const currentZoom = fullMap.getZoom();
        const targetZoom = currentZoom < 16 ? 16 : currentZoom;
        fullMap.setView([lastUserLocation.lat, lastUserLocation.lng], targetZoom, { animate: true });
        
        // Enable follow mode
        followUserLocation = true;
        updateFollowButtonState();
        
        console.log('Centered full map on user location');
      } else {
        alert('User location not available. Please ensure location services are enabled.');
      }
    });
  }

  if (addRoutePointModeBtn) {
    addRoutePointModeBtn.addEventListener('click', function() {
      addRoutePointMode = !addRoutePointMode;
      addRoutePointModeBtn.classList.toggle('active', addRoutePointMode);
      addRoutePointModeBtn.textContent = addRoutePointMode ? 'Adding… (tap map)' : 'Add Point';
    });
  }

  if (markerStyleBtn) {
    // Avoid focusing issues on mobile by using pointerup
    const handler = function() {
      currentMarkerStyle = currentMarkerStyle === 'cross' ? 'dot' : currentMarkerStyle === 'dot' ? 'circle' : 'cross';
      const label = currentMarkerStyle === 'cross' ? 'Marker: Cross' : currentMarkerStyle === 'dot' ? 'Marker: Dot' : 'Marker: Circle';
      markerStyleBtn.textContent = label;
      // Rebuild draw control so new icon is used
      try {
        if (drawControl) {
          fullMap.removeControl(drawControl);
        }
        drawControl = new L.Control.Draw({
          position: 'topright',
          draw: {
            polyline: { shapeOptions: { color: '#ff9800', weight: 3 }, touchExtend: true, repeatMode: true, maxPoints: 1000 },
            polygon: { allowIntersection: false, showArea: true, shapeOptions: { color: '#e91e63', weight: 2, fillOpacity: 0.1 } },
            rectangle: { shapeOptions: { color: '#3f51b5', weight: 2, fillOpacity: 0.1 } },
            circle: false,
            circlemarker: false,
            marker: { icon: createMarkerIcon('pending', currentMarkerStyle), repeatMode: true }
          },
          edit: { featureGroup: annotationLayer, remove: true }
        });
        fullMap.addControl(drawControl);
      } catch(_) {}
    };
    markerStyleBtn.addEventListener('click', handler);
    markerStyleBtn.addEventListener('touchend', function(e){ e.preventDefault(); handler(); });
  }

  // Removed freehand line button to reduce header crowding

  // Manual location request button
  if (requestLocationBtn) {
    requestLocationBtn.addEventListener('click', function() {
      requestLocationPermission();
    });
  }

  // Follow location toggle button
  if (followLocationBtn) {
    // Set initial state
    updateFollowButtonState();
    
    followLocationBtn.addEventListener('click', function() {
      followUserLocation = !followUserLocation;
      updateFollowButtonState();
      
      // If enabling follow mode and we have a location, center on it
      if (followUserLocation && lastUserLocation) {
        if (miniMap) {
          miniMap.setView([lastUserLocation.lat, lastUserLocation.lng], miniMap.getZoom(), { animate: true });
        }
        if (fullMap && !fullMapOverlay.classList.contains('hidden')) {
          fullMap.setView([lastUserLocation.lat, lastUserLocation.lng], fullMap.getZoom(), { animate: true });
        }
      }
    });
  }

  // iOS Safari location fix - request permission first
  requestLocationPermission();
});

// Request location permission and handle iOS Safari issues
async function requestLocationPermission() {
  const mapStatus = document.getElementById('mapStatus');
  
  if (!navigator.geolocation) {
    if (mapStatus) mapStatus.textContent = '📍 Geolocation not supported';
    console.log('Geolocation not supported');
    return;
  }

  // Update status to show we're requesting location
  if (mapStatus) mapStatus.textContent = '📍 Requesting location...';

  // iOS Safari requires HTTPS and user interaction for location
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const isSecure = location.protocol === 'https:' || location.hostname === 'localhost';
  
  if (isIOS && !isSecure) {
    if (mapStatus) mapStatus.textContent = '📍 HTTPS required for location on iOS';
    console.log('iOS requires HTTPS for geolocation');
    return;
  }

  // First try to get current position once to test permissions
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        resolve,
        reject,
        {
          enableHighAccuracy: false, // Start with less accurate for faster response
          maximumAge: 60000, // Accept cached position up to 1 minute
          timeout: 15000 // Longer timeout for iOS
        }
      );
    });

    // Success! Update location immediately
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    const heading = position.coords.heading;
    const accuracy = position.coords.accuracy;
    
    updateUserLocation(lat, lng, heading, accuracy);
    currentLocation.lat = lat;
    currentLocation.lng = lng;

    if (mapStatus) mapStatus.textContent = '📍 Location found';
    console.log('Initial location obtained:', lat, lng);

    // Now start watching position with better accuracy
    startLocationWatching();

  } catch (error) {
    console.log('Geolocation error:', error);
    handleLocationError(error);
  }
}

// Start continuous location watching after initial success
function startLocationWatching() {
  const watchId = navigator.geolocation.watchPosition(
    function(position) {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const heading = position.coords.heading;
      const accuracy = position.coords.accuracy;
      
      updateUserLocation(lat, lng, heading, accuracy);
      currentLocation.lat = lat;
      currentLocation.lng = lng;
    },
    function(error) {
      console.log('Watch position error:', error);
      handleLocationError(error);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 30000,
      timeout: 20000 // Longer timeout for iOS
    }
  );

  // Store watch ID for potential cleanup
  window.locationWatchId = watchId;
}

// Handle different types of location errors
function handleLocationError(error) {
  const mapStatus = document.getElementById('mapStatus');
  const requestLocationBtn = document.getElementById('requestLocationBtn');
  let message = '📍 Location unavailable';

  switch(error.code) {
    case error.PERMISSION_DENIED:
      message = '📍 Tap 📍 to enable location';
      console.log('Location permission denied');
      // Show manual request button
      if (requestLocationBtn) requestLocationBtn.style.display = 'flex';
      // Show instructions for enabling location
      showLocationInstructions();
      break;
    case error.POSITION_UNAVAILABLE:
      message = '📍 Location unavailable';
      console.log('Location information unavailable');
      if (requestLocationBtn) requestLocationBtn.style.display = 'flex';
      break;
    case error.TIMEOUT:
      message = '📍 Location timeout - tap 📍 to retry';
      console.log('Location request timed out');
      if (requestLocationBtn) requestLocationBtn.style.display = 'flex';
      // Retry with less accuracy
      retryLocationWithLowerAccuracy();
      break;
    default:
      message = '📍 Location error - tap 📍 to retry';
      console.log('Unknown location error:', error);
      if (requestLocationBtn) requestLocationBtn.style.display = 'flex';
      break;
  }

  if (mapStatus) mapStatus.textContent = message;
}

// Retry location with lower accuracy settings
function retryLocationWithLowerAccuracy() {
  console.log('Retrying location with lower accuracy...');
  
  navigator.geolocation.getCurrentPosition(
    function(position) {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      const heading = position.coords.heading;
      const accuracy = position.coords.accuracy;
      
      updateUserLocation(lat, lng, heading, accuracy);
      currentLocation.lat = lat;
      currentLocation.lng = lng;
      
      const mapStatus = document.getElementById('mapStatus');
      if (mapStatus) mapStatus.textContent = '📍 Location found (low accuracy)';
      
      // Start watching with lower accuracy
      startLocationWatching();
    },
    function(error) {
      console.log('Retry also failed:', error);
      const mapStatus = document.getElementById('mapStatus');
      if (mapStatus) mapStatus.textContent = '📍 Unable to get location';
    },
    {
      enableHighAccuracy: false,
      maximumAge: 300000, // 5 minutes
      timeout: 30000
    }
  );
}

// Show instructions for enabling location on iOS
function showLocationInstructions() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  
  if (isIOS) {
    // Create a temporary alert for iOS users
    setTimeout(() => {
      alert('To enable location:\n\n1. Go to Settings > Privacy & Security > Location Services\n2. Turn on Location Services\n3. Find Safari in the list\n4. Select "While Using App"\n5. Refresh this page');
    }, 1000);
  }
}

// Update follow button visual state
function updateFollowButtonState() {
  const followLocationBtn = document.getElementById('followLocationBtn');
  if (followLocationBtn) {
    if (followUserLocation) {
      followLocationBtn.classList.add('active');
      followLocationBtn.title = 'Following Location (Click to disable)';
    } else {
      followLocationBtn.classList.remove('active');
      followLocationBtn.title = 'Follow Location (Click to enable)';
    }
  }
}

// Sync user location to full map when it's opened
function syncUserLocationToFullMap() {
  console.log('syncUserLocationToFullMap called', { 
    fullMap: !!fullMap, 
    lastUserLocation: !!lastUserLocation,
    userLocationMarker: !!userLocationMarker 
  });
  
  if (!fullMap) {
    console.error('Full map not available');
    return;
  }
  
  if (!lastUserLocation) {
    console.warn('No user location available to sync');
    return;
  }
  
  try {
    // Force recreate user location marker for full map if needed
    if (lastUserLocation) {
      const location = [lastUserLocation.lat, lastUserLocation.lng];
      
      // Create a new marker specifically for full map to avoid conflicts
      const userIcon = L.divIcon({
        className: 'user-location-marker',
        html: `
          <div class="user-location-container">
            <div class="user-dot-pulse"></div>
            <div class="user-dot">
              <div class="user-dot-inner"></div>
              <div class="user-dot-direction"></div>
            </div>
          </div>
        `,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      
      // Remove existing marker if it exists
      fullMap.eachLayer(function(layer) {
        if (layer.options && layer.options.className === 'user-location-marker') {
          fullMap.removeLayer(layer);
        }
      });
      
      // Add new marker
      const fullMapUserMarker = L.marker(location, { icon: userIcon });
      fullMapUserMarker.addTo(fullMap);
      console.log('Added user location marker to full map at:', location);
      
      // Center the full map on user location
      const currentZoom = fullMap.getZoom();
      const targetZoom = currentZoom < 14 ? 16 : currentZoom;
      fullMap.setView(location, targetZoom, { animate: true });
      console.log('Centered full map on user location');
      
      // Enable follow mode
      followUserLocation = true;
      updateFollowButtonState();
    }
    
  } catch (error) {
    console.error('Error syncing user location to full map:', error);
  }
}

// Add map interaction handlers to disable following when user manually moves map
function addMapInteractionHandlers() {
  if (miniMap) {
    miniMap.on('dragstart', function() {
      // User is manually panning, disable follow mode
      if (followUserLocation) {
        followUserLocation = false;
        updateFollowButtonState();
      }
    });
  }
  
  if (fullMap) {
    fullMap.on('dragstart', function() {
      // User is manually panning, disable follow mode
      if (followUserLocation) {
        followUserLocation = false;
        updateFollowButtonState();
      }
    });
  }
}

// Make functions globally available
window.removeRoutePoint = removeRoutePoint; 

// Attach context menu handlers to toggle scanned/pending and set styles
function attachAnnotationHandlers(layer, props = {}) {
  // Persist style on polylines/polygons when edited
  if (layer.setStyle) {
    const style = layer.options || {};
    layer.feature = layer.feature || { type: 'Feature', properties: {} };
    layer.feature.properties._style = {
      color: style.color,
      weight: style.weight,
      fillColor: style.fillColor,
      fillOpacity: style.fillOpacity
    };
  }
  // Right-click or long-press menu
  layer.on('contextmenu', function(e) {
    if (layer instanceof L.Marker) {
      // Toggle scanned/pending
      const current = (layer.feature && layer.feature.properties && layer.feature.properties.status) || 'pending';
      const next = current === 'scanned' ? 'pending' : 'scanned';
      layer.feature = layer.feature || { type: 'Feature', properties: {} };
      layer.feature.properties.status = next;
      const style = (layer.feature.properties && layer.feature.properties.markerStyle) || currentMarkerStyle;
      const icon = createMarkerIcon(next, style);
      layer.setIcon(icon);
      saveAnnotations();
    }
  });
}

function createMarkerIcon(status = 'pending', style = currentMarkerStyle) {
  let html = '<div class="cross-marker"></div>';
  if (style === 'dot') html = '<div class="dot-marker"></div>';
  if (style === 'circle') html = '<div class="circle-marker"></div>';
  return L.divIcon({ className: `scan-status-marker ${status}`, html, iconSize: [18,18], iconAnchor: [9,9] });
}