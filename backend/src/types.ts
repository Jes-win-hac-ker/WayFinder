export type JourneyStatus = "active" | "alerted" | "completed";

export type Journey = {
  id: string;
  shareTokenHash: string;
  ownerTokenHash: string;
  shareExpiresAt: string;
  duress: boolean;
  travelerId: string;
  contactName: string;
  contactPhone?: string;
  contactEmail?: string;
  eta: string;
  destination?: {
    label: string;
    latitude: number;
    longitude: number;
  };
  gracePeriodMs: number;
  status: JourneyStatus;
  lastHeartbeatAt: string | null;
  lastLocation: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  } | null;
  createdAt: string;
  alertedAt?: string;
};

export type HeartbeatInput = {
  travelerId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  recordedAt?: string;
  duress?: boolean;
};
