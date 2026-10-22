/*// PlayCanvas example script: streamable LOD loader helper
// Usage: add this script to a PlayCanvas entity and call `loadStreamable(urlBase)`

// This script is a simple example demonstrating fetching `lod-meta.json` and
// downloading chunk files. Replace `parseSogBuffer` with your project's SOG parser/viewer.

var StreamedSogLoader = pc.createScript('streamedSogLoader');

StreamedSogLoader.attributes.add('metaUrl', { type: 'string', default: '' });

StreamedSogLoader.prototype.initialize = function() {
    this.chunks = {};
};

StreamedSogLoader.prototype.loadStreamable = async function(urlBase) {
    // urlBase should be the folder that contains lod-meta.json
    const metaUrl = urlBase.replace(/\/$/, '') + '/lod-meta.json';
    console.log('Fetching lod-meta:', metaUrl);

    try {
        const resp = await fetch(metaUrl);
        if (!resp.ok) throw new Error('Failed to fetch lod-meta.json: ' + resp.status);
        const meta = await resp.json();

        // meta should describe the chunks; example field names may vary.
        // We'll collect a list of chunk filenames from meta.files or meta.chunks
        const chunkFiles = [];
        if (meta.files && Array.isArray(meta.files)) {
            meta.files.forEach(f => { if (f.name) chunkFiles.push(f.name); });
        } else if (meta.chunks && Array.isArray(meta.chunks)) {
            meta.chunks.forEach(c => { if (c.file) chunkFiles.push(c.file); });
        } else if (meta.files_list && Array.isArray(meta.files_list)) {
            meta.files_list.forEach(n => chunkFiles.push(n));
        } else {
            console.warn('Cannot find chunk list in lod-meta.json — inspect the file and adapt this loader.');
        }

        // Simple eager download of all chunks (for demonstration). For production,
        // you should stream chunks on demand based on camera view or LOD.
        for (let i = 0; i < chunkFiles.length; i++) {
            const fname = chunkFiles[i];
            const furl = urlBase.replace(/\/$/, '') + '/' + fname;
            console.log('Downloading chunk', furl);
            const r = await fetch(furl);
            if (!r.ok) throw new Error('Failed to fetch chunk: ' + fname);
            const buffer = await r.arrayBuffer();
            this.chunks[fname] = buffer;

            // Register as PlayCanvas binary asset so it's visible in asset registry
            const asset = new pc.Asset('sog-' + fname, 'binary', { url: furl });
            asset.file = { url: furl, filename: fname };
            this.app.assets.add(asset);
            asset.ready(function(a) { console.log('asset ready', a.name); });
            asset.loadFromUrl(furl, 'arraybuffer');

            // Optional: Immediately parse the SOG buffer here (placeholder)
            // parseSogBuffer(buffer);
        }

        console.log('All chunks downloaded and registered as assets.');

    } catch (err) {
        console.error('Stream load failed:', err);
    }
};

// Placeholder: implement or call your SOG parser / viewer to convert chunk buffers
// into PlayCanvas meshes, materials or entities.
function parseSogBuffer(arrayBuffer) {
    // Use your project's SOG parsing code here. This function is intentionally left
    // empty because parsing libraries differ between projects.
}


// Example usage from the PlayCanvas editor console:
// var loader = new pc.createScript('streamedSogLoader')();
// loader.loadStreamable('http://localhost:8080/myModel_Streamable');
*/