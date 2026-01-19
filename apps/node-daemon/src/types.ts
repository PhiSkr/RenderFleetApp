export type JobType = 'image' | 'video';

export interface JobParsed {
  originalName: string; // Dateiname
  fullPath: string;     // Wo gefunden
  type: JobType;
  channel: string;
  jobId: string;
  name: string;
  timestamp: string;    // YYYY-MM-DD (aus Namen oder current)
}
