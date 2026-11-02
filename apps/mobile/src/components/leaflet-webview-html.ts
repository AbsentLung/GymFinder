// A self-contained HTML page (Leaflet pulled from a CDN, not bundled)
// that the native map screen loads into a WebView. This is the one place
// Leaflet still runs on native - not directly (it's DOM-only, confirmed
// this session it crashes immediately just from being imported into a
// native JS bundle), but inside this WebView's own, separate DOM-having
// JS context. The native side and this page talk over postMessage only:
// native sends setView/setMarkers/setClickMode, this page sends back
// ready/markerTap/clusterTap/mapClick/viewportChanged/dragPrefetchPoint.
// Deliberately dumb
// on purpose - it knows nothing about gyms, categories, or filters, just
// "draw circles at these coordinates, tell me when one's tapped." All
// the actual business logic stays in TypeScript on the native side,
// type-checked and consistent with the web implementation, rather than
// being reimplemented twice in two languages.
export const LEAFLET_WEBVIEW_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    var map = L.map('map', { zoomControl: true }).setView([0, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(map);

    var markerLayer = L.layerGroup().addTo(map);
    var clickModeActive = false;

    function post(message) {
      // react-native-webview injects postMessage on window on iOS/Android
      // alike in recent versions, but older Android WebKit builds still
      // only exposed it this way - sending through both costs nothing
      // and avoids depending on exactly which one a given device has.
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(message));
    }

    map.on('click', function (e) {
      if (clickModeActive) post({ type: 'mapClick', lat: e.latlng.lat, lng: e.latlng.lng });
    });

    var viewportTimer = null;
    function sendViewportChanged() {
      clearTimeout(viewportTimer);
      viewportTimer = setTimeout(function () {
        var b = map.getBounds();
        post({
          type: 'viewportChanged',
          zoom: map.getZoom(),
          bounds: { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() },
        });
      }, 150);
    }
    map.on('moveend', sendViewportChanged);
    map.on('zoomend', sendViewportChanged);

    // Mobile's answer to the web map's mouse-hover prefetch - there's no
    // hover on a touchscreen, but 'move' fires continuously WHILE a drag
    // is in progress (before 'moveend'), so the native side can start
    // warming the OSM cache for wherever the user is dragging toward
    // before they actually let go. Throttled here, in the WebView itself,
    // not just on the native side - keeps this to one tiny postMessage
    // every 600ms during a drag instead of one per frame, so it can't
    // compete with the drag gesture's own responsiveness.
    var lastDragPrefetch = 0;
    map.on('move', function () {
      var now = Date.now();
      if (now - lastDragPrefetch < 600) return;
      lastDragPrefetch = now;
      var c = map.getCenter();
      post({ type: 'dragPrefetchPoint', lat: c.lat, lng: c.lng });
    });

    function handleMessage(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      if (msg.type === 'setView') {
        map.setView([msg.lat, msg.lng], msg.zoom);
      } else if (msg.type === 'setClickMode') {
        clickModeActive = !!msg.active;
      } else if (msg.type === 'setMarkers') {
        markerLayer.clearLayers();
        (msg.markers || []).forEach(function (m) {
          var circle = L.circleMarker([m.lat, m.lng], {
            radius: m.radius,
            color: '#146C5F',
            fillColor: m.color,
            fillOpacity: m.isCluster ? 0.75 : 0.9,
          });
          if (m.tooltip) circle.bindTooltip(m.tooltip, { direction: 'top', offset: [0, -6] });
          circle.on('click', function () {
            if (m.isCluster) post({ type: 'clusterTap', clusterId: m.clusterId, lat: m.lat, lng: m.lng });
            else post({ type: 'markerTap', id: m.id });
          });
          circle.addTo(markerLayer);
        });
      } else if (msg.type === 'setPendingPin') {
        markerLayer.eachLayer(function (l) { if (l._isPendingPin) markerLayer.removeLayer(l); });
        if (msg.lat != null) {
          var pin = L.circleMarker([msg.lat, msg.lng], {
            radius: 8,
            color: '#B8860B',
            fillColor: '#E0A500',
            fillOpacity: 0.9,
          });
          pin._isPendingPin = true;
          pin.bindTooltip('New gym (pending)', { direction: 'top', offset: [0, -6], permanent: true });
          pin.addTo(markerLayer);
        }
      }
    }

    // Android WebView delivers postMessage via 'message' on document;
    // iOS (and some Android versions) deliver it on window - listening
    // on both is the standard react-native-webview workaround, not
    // redundant for one specific platform.
    document.addEventListener('message', function (e) { handleMessage(e.data); });
    window.addEventListener('message', function (e) { handleMessage(e.data); });

    post({ type: 'ready' });
  </script>
</body>
</html>`
