export type TranscriptMessage = {
  role: "customer" | "assistant";
  text: string;
  time: string;
};
export type SalesStatus =
  | "Converted" | "Interested" | "Follow-up Required"
  | "Not Interested" | "Demo Requested" | "No Response";
export type CallRecord = {
  id: string;
  created_at: string;
  duration_seconds: number;
  transcript: TranscriptMessage[];
  summary: string;
  requirements: string[];
  objections: string[];
  next_steps: string;
  status: SalesStatus;
  recordingAvailable: boolean;
  completed: number;
};
