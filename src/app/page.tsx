"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MapLibreMap, Marker } from "maplibre-gl";
import type { Socket } from "socket.io-client";
import "maplibre-gl/dist/maplibre-gl.css";
import styles from "./page.module.css";

type Point = { longitude: number; latitude: number };
type JourneyStatus = "active" | "alerted" | "completed";
type SharedJourney = {
  id: string;
  status: JourneyStatus;
  eta: string;
  destination: { label: string; latitude: number; longitude: number } | null;
  lastHeartbeatAt: string | null;
  lastLocation: { latitude: number; longitude: number; accuracy?: number } | null;
  duress?: boolean;
};

const initialRoute: Point[] = [
  { longitude: 76.2673, latitude: 9.9312 },
  { longitude: 76.2714, latitude: 9.9338 },
  { longitude: 76.2756, latitude: 9.9364 },
  { longitude: 76.2798, latitude: 9.939 },
  { longitude: 76.284, latitude: 9.9416 },
];

function formatCoordinate(value: number | null, axis: "lat" | "lng") {
  if (value === null) return "—";
  return `${Math.abs(value).toFixed(4)}° ${value >= 0 ? (axis === "lat" ? "N" : "E") : axis === "lat" ? "S" : "W"}`;
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const minutes = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const remaining = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${hours}:${minutes}:${remaining}`;
}

function formatPace(secondsPerKm: number | null) {
  if (secondsPerKm === null || !Number.isFinite(secondsPerKm)) return "— /km";
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.floor(secondsPerKm % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds} /km`;
}

function distanceBetween(a: Point, b: Point) {
  const earthRadius = 6371e3;
  const latDelta = (b.latitude - a.latitude) * Math.PI / 180;
  const lngDelta = (b.longitude - a.longitude) * Math.PI / 180;
  const value = Math.sin(latDelta / 2) ** 2
    + Math.cos(a.latitude * Math.PI / 180) * Math.cos(b.latitude * Math.PI / 180) * Math.sin(lngDelta / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function formatDistance(meters: number | null) {
  if (meters === null) return "—";
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const marker = useRef<Marker | null>(null);
  const destinationMarker = useRef<Marker | null>(null);
  const estimateDestinationRef = useRef<(next: Point) => void>(() => undefined);
  const maplibre = useRef<typeof import("maplibre-gl") | null>(null);
  const socket = useRef<Socket | null>(null);
  const watchId = useRef<number | null>(null);
  const duressIntervalId = useRef<number | null>(null);
  const journeyIdRef = useRef<string | null>(null);
  const ownerTokenRef = useRef<string | null>(null);
  const lastAcceptedPosition = useRef<Point | null>(null);
  const lastAcceptedAt = useRef(0);
  const cameraIntroStarted = useRef(false);
  const sharedCameraLocation = useRef<string | null>(null);
  const isStopping = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const suppressNextPress = useRef(false);
  const [isTracking, setIsTracking] = useState(false);
  const [position, setPosition] = useState<Point | null>(null);
  const [route, setRoute] = useState<Point[]>(initialRoute);
  const [error, setError] = useState("");
  const [journeyId, setJourneyId] = useState<string | null>(null);
  const [sharePin, setSharePin] = useState<string | null>(null);
  const [shareStatus, setShareStatus] = useState("");
  const [journeyStatus, setJourneyStatus] = useState<JourneyStatus>("active");
  const [backendConnected, setBackendConnected] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [activeNav, setActiveNav] = useState("overview");
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [destination, setDestination] = useState<Point | null>(null);
  const [destinationLabel, setDestinationLabel] = useState("");
  const [destinationSearch, setDestinationSearch] = useState("");
  const [isSearchingDestination, setIsSearchingDestination] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [destinationDistance, setDestinationDistance] = useState<number | null>(null);
  const [destinationEta, setDestinationEta] = useState<number | null>(null);
  const [roadRoute, setRoadRoute] = useState<Point[] | null>(null);
  const routeSourceReady = useRef(false);
  const [trackingStartedAt, setTrackingStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [speedKph, setSpeedKph] = useState<number | null>(null);
  const [paceSecondsPerKm, setPaceSecondsPerKm] = useState<number | null>(null);
  const [isDuress, setIsDuress] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [sharedJourney, setSharedJourney] = useState<SharedJourney | null>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginPin, setLoginPin] = useState("");
  const [trustedPin, setTrustedPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isLoadingPin, setIsLoadingPin] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";
  const travelerId = "alex-rivera-demo";
  const isTrustedViewer = sharedJourney !== null;
  const sharedLocation = sharedJourney?.lastLocation;

  useEffect(() => {
    const hydrateAuth = window.setTimeout(() => {
      const authToken = window.localStorage.getItem("wayfinder-auth");
      const savedSession = window.sessionStorage.getItem("wayfinder-active-session");
      const savedViewerCode = window.sessionStorage.getItem("wayfinder-share-code");
      setIsAuthenticated(Boolean(authToken));
      if (savedViewerCode) {
        setTrustedPin(savedViewerCode);
      } else if (savedSession) {
        try {
          const session = JSON.parse(savedSession) as {
            journeyId: string;
            shareToken: string;
            ownerToken: string;
            startedAt: number;
            destination?: { label: string; latitude: number; longitude: number };
            contactName?: string;
            contactEmail?: string;
            contactPhone?: string;
            duress?: boolean;
          };
          journeyIdRef.current = session.journeyId;
          ownerTokenRef.current = session.ownerToken;
          setJourneyId(session.journeyId);
          setSharePin(session.shareToken);
          setTrackingStartedAt(session.startedAt);
          setIsTracking(true);
          if (session.destination) {
            setDestination(session.destination);
            setDestinationLabel(session.destination.label);
            setDestinationSearch(session.destination.label);
          }
          setContactName(session.contactName ?? "");
          setContactEmail(session.contactEmail ?? "");
          setContactPhone(session.contactPhone ?? "");
          setIsDuress(session.duress === true);
        } catch {
          window.sessionStorage.removeItem("wayfinder-active-session");
        }
      }
      setIsHydrated(true);
    }, 0);
    return () => window.clearTimeout(hydrateAuth);
  }, []);

  const loadSharedJourney = useCallback(async (pin: string) => {
    const response = await fetch(`${backendUrl}/journeys/share/${encodeURIComponent(pin)}`);
    const data = await response.json() as SharedJourney | { error?: string };
    if (!response.ok || !("id" in data)) throw new Error("Invalid or expired PIN.");
    setSharedJourney(data);
    setTrustedPin(pin);
    window.sessionStorage.setItem("wayfinder-share-code", pin);
    if (data.lastLocation) {
      setPosition({ longitude: data.lastLocation.longitude, latitude: data.lastLocation.latitude });
    }
    setJourneyStatus(data.status);
    if (data.destination) {
      setDestination(data.destination);
      setDestinationLabel(data.destination.label);
    }
    setIsAuthenticated(true);
  }, [backendUrl]);

  useEffect(() => {
    if (!isHydrated || sharedJourney || !trustedPin) return;
    const restoreViewer = window.setTimeout(() => {
      void loadSharedJourney(trustedPin).catch(() => {
        setLoginError("This share code is invalid or expired.");
        window.sessionStorage.removeItem("wayfinder-share-code");
      });
    }, 0);
    return () => window.clearTimeout(restoreViewer);
  }, [isHydrated, loadSharedJourney, sharedJourney, trustedPin]);

  useEffect(() => {
    const location = sharedLocation;
    const currentMap = map.current;
    if (!location || !currentMap || !maplibre.current || !mapReady) return;
    const key = `${location.longitude}:${location.latitude}`;
    if (sharedCameraLocation.current === key) return;
    sharedCameraLocation.current = key;
    marker.current?.setLngLat([location.longitude, location.latitude]);
    if (!marker.current) {
      marker.current = new maplibre.current.Marker({ color: "#ef8354" })
        .setLngLat([location.longitude, location.latitude])
        .addTo(currentMap);
    }
    currentMap.flyTo({
      center: [location.longitude, location.latitude],
      zoom: 15,
      pitch: 18,
      duration: 1600,
      essential: true,
    });
  }, [sharedLocation, mapReady]);

  useEffect(() => {
    if (!sharedJourney) return;
    const sync = () => void loadSharedJourney(trustedPin);
    const interval = window.setInterval(sync, 5000);
    return () => window.clearInterval(interval);
  }, [loadSharedJourney, trustedPin, sharedJourney]);

  const updateDestinationEstimate = useCallback((next: Point) => {
    const origin = position ?? initialRoute[0];
    const meters = distanceBetween(origin, next);
    setDestinationDistance(meters);
    setDestinationEta(Math.max(1, Math.round(meters / 1000 / 30 * 60)));
    if (!position && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(({ coords }) => {
        const liveOrigin = { latitude: coords.latitude, longitude: coords.longitude };
        setPosition(liveOrigin);
        const liveMeters = distanceBetween(liveOrigin, next);
        setDestinationDistance(liveMeters);
        setDestinationEta(Math.max(1, Math.round(liveMeters / 1000 / 30 * 60)));
      }, () => undefined, { enableHighAccuracy: false, maximumAge: 30000, timeout: 10000 });
    }
  }, [position]);

  useEffect(() => {
    if (!destination) return;
    const origin = position ?? initialRoute[0];
    const controller = new AbortController();
    const coordinates = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    void fetch(`https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("OSRM routing unavailable");
        return response.json() as Promise<{ routes?: Array<{ distance: number; duration: number; geometry?: { coordinates: [number, number][] } }> }>;
      })
      .then((data) => {
        const routeResult = data.routes?.[0];
        if (!routeResult) throw new Error("No route found");
        setDestinationDistance(routeResult.distance);
        setDestinationEta(Math.max(1, Math.round(routeResult.duration / 60)));
        setRoadRoute(routeResult.geometry?.coordinates.map(([longitude, latitude]) => ({ longitude, latitude })) ?? null);
      })
      .catch((routeError: unknown) => {
        if (routeError instanceof DOMException && routeError.name === "AbortError") return;
        setRoadRoute(null);
      });
    return () => controller.abort();
  }, [destination, position]);
  useEffect(() => {
    estimateDestinationRef.current = updateDestinationEstimate;
  }, [updateDestinationEstimate]);

  useEffect(() => {
    let active = true;
    void import("maplibre-gl").then((maplibregl) => {
      if (!active || !mapContainer.current || map.current) return;
      maplibre.current = maplibregl;
      map.current = new maplibregl.Map({
        container: mapContainer.current,
        style: {
          version: 8,
          sources: {
            basemap: {
              type: "raster",
              tiles: [`https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}`],
              tileSize: 512,
            },
          },
          layers: [{ id: "basemap", type: "raster", source: "basemap" }],
        },
        center: [76.2756, 9.9364],
        zoom: 10.5,
        attributionControl: false,
      });
      map.current.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      const currentMap = map.current;
      currentMap.on("click", (event) => {
        const next = { longitude: event.lngLat.lng, latitude: event.lngLat.lat };
        setDestination(next);
        setDestinationLabel("Selected map location");
        estimateDestinationRef.current(next);
        if (maplibre.current) {
          destinationMarker.current?.remove();
          destinationMarker.current = new maplibre.current.Marker({ color: "#263a34" }).setLngLat([next.longitude, next.latitude]).addTo(currentMap);
        }
        currentMap.fitBounds([
          currentMap.getCenter().toArray(),
          [next.longitude, next.latitude],
        ], { padding: 110, maxZoom: 14.5, pitch: 8, duration: 1100, essential: true });
      });
      currentMap.on("load", () => {
        currentMap.addSource("route", {
          type: "geojson",
          data: {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates: initialRoute.map(({ longitude, latitude }) => [longitude, latitude]) },
          },
        });
        currentMap.addLayer({
          id: "route-casing",
          type: "line",
          source: "route",
          paint: { "line-color": "#fffaf0", "line-width": 10, "line-opacity": 0.95 },
          layout: { "line-cap": "round", "line-join": "round" },
        });
        currentMap.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          paint: { "line-color": "#ef8354", "line-width": 6, "line-opacity": 1 },
          layout: { "line-cap": "round", "line-join": "round" },
        });
        routeSourceReady.current = true;
        setMapReady(true);
        if (!cameraIntroStarted.current) {
          cameraIntroStarted.current = true;
          const previewCenter: [number, number] = [76.2756, 9.9364];
          currentMap.flyTo({ center: previewCenter, zoom: 12, pitch: 8, duration: 1100, essential: true });
          if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(({ coords }) => {
              const liveOrigin = { longitude: coords.longitude, latitude: coords.latitude };
              setPosition(liveOrigin);
              if (!marker.current && maplibre.current) {
                marker.current = new maplibre.current.Marker({ color: "#ef8354" })
                  .setLngLat([liveOrigin.longitude, liveOrigin.latitude])
                  .addTo(currentMap);
              }
              currentMap.flyTo({
                center: [liveOrigin.longitude, liveOrigin.latitude],
                zoom: 15,
                pitch: 18,
                bearing: 0,
                duration: 2200,
                essential: true,
              });
            }, () => {
              currentMap.flyTo({ center: previewCenter, zoom: 13.7, pitch: 8, duration: 1400, essential: true });
            }, { enableHighAccuracy: false, maximumAge: 30000, timeout: 10000 });
          } else {
            currentMap.flyTo({ center: previewCenter, zoom: 13.7, pitch: 8, duration: 1400, essential: true });
          }
        }
      });
    });
    return () => {
      active = false;
      if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
      map.current?.remove();
      map.current = null;
    };
  }, [backendUrl, isHydrated, isAuthenticated]);

  useEffect(() => {
    let active = true;
    void import("socket.io-client").then(({ io }) => {
      if (!active) return;
      const connection = io(backendUrl, { autoConnect: true, transports: ["websocket", "polling"] });
      socket.current = connection;
      connection.on("connect", () => setBackendConnected(true));
      connection.on("disconnect", () => setBackendConnected(false));
      connection.on("journey:alert", () => {
        if (watchId.current !== null) navigator.geolocation?.clearWatch(watchId.current);
        watchId.current = null;
        setJourneyStatus("alerted");
        setIsTracking(false);
        setTrackingStartedAt(null);
        setError("Dead man’s switch alert triggered. Your trusted contact needs attention.");
      });
      connection.on("journey:completed", () => setJourneyStatus("completed"));
    });
    return () => {
      active = false;
      socket.current?.disconnect();
      socket.current = null;
    };
  }, [backendUrl]);

  useEffect(() => {
    const currentMap = map.current;
    if (!currentMap || !maplibre.current) return;
    if (!currentMap.isStyleLoaded()) {
      currentMap.once("load", () => setMapReady(true));
      return;
    }
    if (!currentMap.getSource("route")) {
      currentMap.addSource("route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
      });
      currentMap.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        paint: { "line-color": "#fffaf0", "line-width": 10, "line-opacity": 0.95 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      currentMap.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        paint: { "line-color": "#ef8354", "line-width": 6, "line-opacity": 1 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      routeSourceReady.current = true;
    }
    const source = currentMap.getSource("route");
    if (!source || source.type !== "geojson") return;
    const origin = position ?? initialRoute[0];
    const coordinates: [number, number][] = destination
      ? [[origin.longitude, origin.latitude], [destination.longitude, destination.latitude]]
      : route.map(({ longitude, latitude }) => [longitude, latitude] as [number, number]);
    (source as GeoJSONSource).setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates },
    });
    if (destination) {
      const bounds = coordinates.reduce(
        (result, coordinate) => result.extend(coordinate),
        new maplibre.current.LngLatBounds(coordinates[0], coordinates[0]),
      );
      currentMap.fitBounds(bounds, { padding: 70, maxZoom: 15, pitch: 8, duration: 600 });
    }
  }, [route, position, destination, roadRoute, mapReady]);

  const stopTracking = useCallback(() => {
    if (isStopping.current) return;
    isStopping.current = true;
    if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    watchId.current = null;
    if (duressIntervalId.current !== null) window.clearInterval(duressIntervalId.current);
    duressIntervalId.current = null;
    setIsTracking(false);
    setTrackingStartedAt(null);
    const activeJourneyId = journeyIdRef.current;
    if (!activeJourneyId) {
      isStopping.current = false;
      return;
    }
    socket.current?.emit("journey:leave", activeJourneyId);
    void fetch(`${backendUrl}/journeys/${activeJourneyId}/complete`, {
        method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokenRef.current ?? ""}` },
        body: JSON.stringify({ travelerId }),
      }).then((response) => {
        if (!response.ok) throw new Error("Could not complete journey");
        setJourneyStatus("completed");
      }).catch(() => setError("Tracking stopped locally, but the backend could not complete the journey."))
        .finally(() => {
          journeyIdRef.current = null;
          ownerTokenRef.current = null;
          window.sessionStorage.removeItem("wayfinder-active-session");
          isStopping.current = false;
        });
  }, [backendUrl]);

  const startTracking = async (duress = false) => {
    if (!navigator.geolocation) {
      setError("Location services are not available in this browser.");
      return;
    }
    if (!backendConnected) {
      setError(`Backend is offline. Start it at ${backendUrl} before sharing a journey.`);
      return;
    }
    if (!destination && !duress) {
      setError("Choose a destination before starting the journey.");
      return;
    }
    if ((!contactName.trim() || (!contactEmail.trim() && !contactPhone.trim())) && !duress) {
      setError("Add the trusted person’s name and an email or phone number.");
      return;
    }
    setError("");
    setIsStarting(true);
    try {
      const response = await fetch(`${backendUrl}/journeys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          travelerId,
          contactName: contactName.trim() || (duress ? "Emergency Protocol" : ""),
          ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : (!contactPhone.trim() && duress ? { contactPhone: "000-000-0000" } : {})),
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
          duress,
          eta: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          destination: destination ? { ...destination, label: destinationLabel || "Selected destination" } : { latitude: 37.7749, longitude: -122.4194, label: "Emergency Location" },
        }),
      });
      const responseText = await response.text();
      let journey: { id?: string; shareToken?: string; ownerToken?: string; error?: string };
      try {
        journey = JSON.parse(responseText) as { id?: string; error?: string };
      } catch {
        throw new Error(`Backend returned an invalid response (${response.status}). Restart the backend and try again.`);
      }
      if (!response.ok) throw new Error(journey.error ?? "Could not create journey");
      if (!journey.id) throw new Error("Backend created the journey without an ID.");
      setJourneyId(journey.id);
      if (!journey.shareToken || !journey.ownerToken) throw new Error("Journey created without secure sharing credentials.");
      setSharePin(journey.shareToken);
      ownerTokenRef.current = journey.ownerToken;
      window.sessionStorage.setItem("wayfinder-active-session", JSON.stringify({
        journeyId: journey.id,
        shareToken: journey.shareToken,
        ownerToken: journey.ownerToken,
        startedAt: Date.now(),
        destination: destination ? { ...destination, label: destinationLabel || "Selected destination" } : { latitude: 37.7749, longitude: -122.4194, label: "Emergency Location" },
        contactName: contactName.trim() || (duress ? "Emergency Protocol" : ""),
        contactEmail: contactEmail.trim(),
        contactPhone: contactPhone.trim() || (duress && !contactEmail.trim() ? "000-000-0000" : ""),
        duress,
      }));
      setShareStatus("");
      journeyIdRef.current = journey.id;
      setJourneyStatus("active");
      setTrackingStartedAt(Date.now());
      setElapsedSeconds(0);
      setDistanceMeters(0);
      setSpeedKph(null);
      setPaceSecondsPerKm(null);
      setIsDuress(duress);
      socket.current?.emit("journey:join", { journeyId: journey.id, token: ownerTokenRef.current });
      setIsTracking(true);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not create journey.");
      return;
    } finally {
      setIsStarting(false);
    }
    lastAcceptedPosition.current = null;
    lastAcceptedAt.current = 0;
    if (duress) {
      const fakeStart = { latitude: 37.7749, longitude: -122.4194 };
      const fakeEnd = { latitude: 37.7849, longitude: -122.4094 };
      setRoute([fakeStart, fakeEnd]);
      setPosition(fakeStart);
      setDistanceMeters(0);
      setSpeedKph(15);
      setPaceSecondsPerKm(240);
      
      if (map.current && maplibre.current) {
        if (!marker.current) {
          marker.current = new maplibre.current.Marker({ color: "#ef8354" }).setLngLat([fakeStart.longitude, fakeStart.latitude]).addTo(map.current);
        } else {
          marker.current.setLngLat([fakeStart.longitude, fakeStart.latitude]);
        }
        map.current.easeTo({ center: [fakeStart.longitude, fakeStart.latitude], zoom: 15, pitch: 8, duration: 400 });
      }
    }

    watchId.current = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const next = { longitude: coords.longitude, latitude: coords.latitude };
        if (journeyIdRef.current) {
          void fetch(`${backendUrl}/journeys/${journeyIdRef.current}/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerTokenRef.current ?? ""}` },
            body: JSON.stringify({ travelerId, latitude: next.latitude, longitude: next.longitude, accuracy: coords.accuracy, duress }),
          }).catch(() => {
            if (!duress) setError("GPS is active, but the backend missed a heartbeat.");
          });
        }
        if (duress) return;
        setPosition(next);
        const previous = lastAcceptedPosition.current;
        const distance = previous
          ? Math.hypot((next.longitude - previous.longitude) * 111_320 * Math.cos(next.latitude * Math.PI / 180), (next.latitude - previous.latitude) * 111_320)
          : Infinity;
        const now = Date.now();
        if (previous && distance < 10 && now - lastAcceptedAt.current < 5000) return;
        lastAcceptedPosition.current = next;
        lastAcceptedAt.current = now;
        if (previous) setDistanceMeters((current) => current + distance);
        if (typeof coords.speed === "number" && Number.isFinite(coords.speed) && coords.speed >= 0) {
          setSpeedKph(coords.speed * 3.6);
          setPaceSecondsPerKm(coords.speed > 0 ? 1000 / coords.speed : null);
        }
        setRoute((current) => previous ? [...current, next] : [next]);
        if (map.current && maplibre.current) {
          if (!marker.current) {
            marker.current = new maplibre.current.Marker({ color: "#ef8354" }).setLngLat([next.longitude, next.latitude]).addTo(map.current);
          } else {
            marker.current.setLngLat([next.longitude, next.latitude]);
          }
          if (!previous || distance > 100) {
            map.current.easeTo({ center: [next.longitude, next.latitude], zoom: 15, pitch: 8, duration: 400 });
          }
        }
      },
      () => {
        setError("Location permission was declined. Enable it in your browser settings to start tracking.");
        stopTracking();
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  };

  const searchDestination = async () => {
    const query = destinationSearch.trim();
    if (!query) return;
    setIsSearchingDestination(true);
    setError("");
    try {
      const response = await fetch(`https://api.maptiler.com/geocoding/${encodeURIComponent(query)}.json?key=${process.env.NEXT_PUBLIC_MAPTILER_KEY}&limit=1`);
      const data = await response.json() as { features?: Array<{ place_name?: string; center?: [number, number] }> };
      const feature = data.features?.[0];
      if (!feature?.center) throw new Error("Destination not found. Try a city, address, or landmark.");
      const [longitude, latitude] = feature.center;
      const next = { longitude, latitude };
      setDestination(next);
      setDestinationLabel(feature.place_name ?? query);
      setDestinationSearch(feature.place_name ?? query);
      updateDestinationEstimate(next);
      if (map.current && maplibre.current) {
        destinationMarker.current?.remove();
        destinationMarker.current = new maplibre.current.Marker({ color: "#263a34" }).setLngLat([longitude, latitude]).addTo(map.current);
        map.current.fitBounds([
          position ? [position.longitude, position.latitude] : map.current.getCenter().toArray(),
          [longitude, latitude],
        ], { padding: 110, maxZoom: 14.5, pitch: 8, duration: 1100, essential: true });
      }
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "Could not find that destination.");
    } finally {
      setIsSearchingDestination(false);
    }
  };

  const shareJourneyPin = async () => {
    if (!sharePin) return;
    try {
      await navigator.clipboard.writeText(sharePin);
      setShareStatus("Copied");
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setShareStatus("Select and copy the code");
    }
  };

  useEffect(() => {
    if (!isTracking || !trackingStartedAt) return;
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - trackingStartedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [isTracking, trackingStartedAt]);

  const distanceLabel = distanceMeters >= 1000 ? `${(distanceMeters / 1000).toFixed(2)} km` : distanceMeters > 0 ? `${Math.round(distanceMeters)} m` : "—";
  const speedLabel = speedKph === null ? "—" : `${speedKph.toFixed(1)} km/h`;
  const navigateTo = (section: string, target: string) => {
    setActiveNav(section);
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const signIn = () => {
    window.localStorage.setItem("wayfinder-auth", travelerId);
    setIsAuthenticated(true);
  };

  const logOut = () => {
    if (isTracking) stopTracking();
    window.localStorage.removeItem("wayfinder-auth");
    window.sessionStorage.removeItem("wayfinder-active-session");
    window.sessionStorage.removeItem("wayfinder-share-code");
    setSharedJourney(null);
    setTrustedPin("");
    setIsAuthenticated(false);
    setShowProfile(false);
  };

  const clearLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleJourneyPointerDown = () => {
    if (isTracking || isStarting || isTrustedViewer) return;
    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      suppressNextPress.current = true;
      void startTracking(true);
    }, 700);
  };

  const handleJourneyPress = () => {
    clearLongPress();
    if (suppressNextPress.current) {
      suppressNextPress.current = false;
      return;
    }
    if (isTracking) {
      stopTracking();
    } else {
      void startTracking(false);
    }
  };

  const signInWithPin = async () => {
    const pin = loginPin.trim();
    if (!/^[A-Za-z0-9_-]{32}$/.test(pin)) {
      setLoginError("Enter the complete 32-character share code.");
      return;
    }
    setIsLoadingPin(true);
    setLoginError("");
    try {
      await loadSharedJourney(pin);
    } catch (pinError) {
      setLoginError(pinError instanceof Error ? pinError.message : "Could not load this journey.");
    } finally {
      setIsLoadingPin(false);
    }
  };

  if (!isHydrated) {
    return <main className={styles.loginPage} aria-busy="true" />;
  }

  if (!isAuthenticated) {
    return (
      <main className={styles.loginPage}>
        <section className={styles.loginCard}>
          <div className={styles.brand}>WayFinder</div>
          <p className={styles.eyebrow}>Location tracking</p>
          <h1>Welcome back</h1>
          <p className={styles.loginIntro}>Sign in to continue.</p>
          <form className={styles.loginForm} onSubmit={(event) => { event.preventDefault(); signIn(); }}>
            <label>Email<input type="email" value={loginEmail} onChange={(event) => setLoginEmail(event.target.value)} placeholder="you@example.com" autoComplete="email" /></label>
            <label>Password<input type="password" value={loginPassword} onChange={(event) => setLoginPassword(event.target.value)} placeholder="••••••••" autoComplete="current-password" /></label>
            <button className={styles.loginButton} type="submit">Sign in</button>
          </form>
          <button className={styles.bypassButton} type="button" onClick={signIn}>Continue as Alex Rivera</button>
          <div className={styles.loginDivider}>or</div>
          <form className={styles.loginForm} onSubmit={(event) => { event.preventDefault(); void signInWithPin(); }}>
            <label>Trusted person code<input inputMode="text" pattern="[A-Za-z0-9_-]{32}" maxLength={32} value={loginPin} onChange={(event) => setLoginPin(event.target.value.replace(/[^A-Za-z0-9_-]/g, ""))} placeholder="Enter share code" aria-label="Trusted person share code" /></label>
            {loginError && <p className={styles.loginError} role="alert">{loginError}</p>}
            <button className={styles.bypassButton} type="submit" disabled={isLoadingPin}>{isLoadingPin ? "Loading…" : "View shared journey"}</button>
          </form>
          <small className={styles.demoNote}>Demo account</small>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <footer className={styles.sidebar}>
        <div className={styles.brand}>WayFinder</div>
        <nav className={styles.nav} aria-label="Main navigation">
          <button className={activeNav === "overview" ? styles.navItemActive : styles.navItem} onClick={() => navigateTo("overview", "overview")}><span>◉</span> Overview</button>
          <button className={activeNav === "trips" ? styles.navItemActive : styles.navItem} onClick={() => navigateTo("trips", "session")}><span>↗</span> Trips <b>{journeyId ? "1" : "0"}</b></button>
          <button className={activeNav === "places" ? styles.navItemActive : styles.navItem} onClick={() => navigateTo("places", "coordinates")}><span>⌖</span> Saved places</button>
        </nav>
        <div className={styles.sidebarBottom}>
          <button className={styles.security} onClick={() => setShowPrivacy((current) => !current)} aria-label="Privacy">●</button>
          <div className={styles.profileWrap}><button className={styles.profile} onClick={() => setShowProfile((current) => !current)} aria-label="Profile"><div className={styles.avatar}>AR</div><span>•••</span></button>{showProfile && <div className={styles.popover}><strong>{isTrustedViewer ? "Trusted viewer" : "Alex Rivera"}</strong><small>{isTrustedViewer ? "Shared journey" : "Personal account"}</small><button className={styles.logoutButton} type="button" onClick={logOut}>Log out</button></div>}</div>
        </div>
        {showPrivacy && <div className={`${styles.popover} ${styles.privacyPopover}`}><strong>Private</strong><small>GPS is sent only while tracking.</small></div>}
      </footer>

      <section className={styles.content} id="overview">
        <header className={styles.header}><div><p className={styles.eyebrow}>WayFinder</p><h1>Location tracking <span>✦</span></h1></div><button className={styles.iconButton} aria-label="Notifications">♧<i /></button></header>

        <div className={styles.statusBar}><div className={`${styles.statusDot} ${isTracking || isTrustedViewer ? (isDuress ? styles.liveDuress : styles.live) : ""}`} /><span>{isTrustedViewer ? "Shared journey" : isTracking ? (isDuress ? "Live tracking active" : "Live tracking is on") : journeyStatus === "alerted" ? "Alert triggered" : "Ready to track"}</span>{!backendConnected && <><span className={styles.statusDivider} /><span className={styles.muted}>Backend offline</span></>}</div>
        {error && <p className={styles.error} role="alert">{error}</p>}
        {isTrustedViewer && sharedJourney && <p className={styles.sharedBanner}>Shared journey · Syncing every 5s</p>}
        {journeyId && sharePin && <div className={styles.journeyMeta}><span className={styles.sharePin}><span><small>SHARE CODE</small><b>{sharePin}</b></span><button type="button" onClick={() => void shareJourneyPin()}>Share</button>{shareStatus && <small>{shareStatus}</small>}</span></div>}
        <div className={`${styles.destinationPicker} ${isTracking ? styles.destinationActive : ""}`}>
          <div><p className={styles.eyebrow}>{isTracking ? "Active journey" : "Journey destination"}</p><strong>{destinationLabel || "Choose where you are going"}</strong></div>
          <div className={styles.destinationSearch}><input value={destinationSearch} onChange={(event) => setDestinationSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void searchDestination(); }} placeholder="Search a city, address, or landmark" aria-label="Journey destination" disabled={isTracking} /><button onClick={() => void searchDestination()} disabled={isSearchingDestination || isTracking}>{isSearchingDestination ? "…" : "Find"}</button></div>
          {destination && <div className={styles.destinationEstimate}><span><b>{formatDistance(destinationDistance)}</b> distance</span><span><b>{destinationEta ? `${destinationEta} min` : "—"}</b> ETA</span></div>}
          {isTracking && <small>Destination locked</small>}
        </div>
        {!isTrustedViewer && <section className={styles.contactCard}>
          <div><p className={styles.eyebrow}>Trusted person</p><strong>Who should receive your journey?</strong></div>
          <div className={styles.contactFields}>
            <input value={contactName} onChange={(event) => setContactName(event.target.value)} placeholder="Name" aria-label="Trusted person name" disabled={isTracking} />
            <input type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} placeholder="Email" aria-label="Trusted person email" disabled={isTracking} />
            <input type="tel" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} placeholder="Phone" aria-label="Trusted person phone" disabled={isTracking} />
          </div>
          <small>Alerts use the contact details you provide.</small>
        </section>}

        <div className={styles.grid}>
          <div className={styles.mapCard}><div className={styles.map} ref={mapContainer} /><div className={styles.mapOverlay}><span className={styles.livePill}><i /> {isTracking ? "LIVE" : "PREVIEW"}</span></div></div>
          <div className={styles.statsCard} id="session"><div className={styles.cardHeading}><span>{isTracking ? "Session" : "Preview"}</span><span className={styles.more}>•••</span></div><div className={styles.bigStat}>{elapsedSeconds > 0 ? formatDuration(elapsedSeconds) : "00:00:00"}<small>{elapsedSeconds > 0 ? "duration" : "waiting"}</small></div><div className={styles.statRows}><div><span>Distance</span><strong>{distanceMeters > 0 ? distanceLabel : "0.0 km"}</strong></div><div><span>Pace</span><strong>{formatPace(paceSecondsPerKm)}</strong></div><div><span>Speed</span><strong>{speedKph !== null ? speedLabel : "— km/h"}</strong></div></div></div>
        </div>

        <section className={styles.details} id="coordinates"><div className={styles.sectionHeading}><div><p className={styles.eyebrow}>Coordinates</p><h2>Current location</h2></div></div><div className={styles.coordinateGrid}><div><span>Latitude</span><strong>{formatCoordinate(position?.latitude ?? 9.9364, "lat")}</strong></div><div><span>Longitude</span><strong>{formatCoordinate(position?.longitude ?? 76.2756, "lng")}</strong></div><div><span>Accuracy</span><strong>{position ? "± 12 m" : "± 25 m"}</strong></div><div><span>Signal</span><strong className={styles.signal}><i /><i /><i /><i /></strong></div></div></section>
        <button disabled={isTrustedViewer || isStarting || journeyStatus !== "active"} onPointerDown={handleJourneyPointerDown} onPointerUp={clearLongPress} onPointerLeave={clearLongPress} onPointerCancel={clearLongPress} onClick={handleJourneyPress} className={`${isTracking ? styles.stopButton : styles.trackButton} ${styles.journeyAction}`}>{isTrustedViewer ? "Viewing" : isStarting ? "Creating journey…" : isTracking ? "Stop tracking" : "Start journey"} <span>{isTracking ? "×" : "→"}</span></button>
      </section>
    </main>
  );
}
