export interface ResumeData {
  name: string;
  title: string;
  summary: string;
  contact: ResumeContact;
  sections: ResumeSection[];
}

export interface ResumeContact {
  email: string;
  phone?: string;
  github?: string;
  website?: string;
  linkedin?: string;
}

export type SectionType =
  | "experience"
  | "education"
  | "skills"
  | "projects"
  | "certifications"
  | "languages";

export interface ResumeSection {
  type: SectionType;
  title: string;
  items: ResumeItem[];
}

export interface ResumeItem {
  title: string;
  subtitle?: string;
  dateRange?: string;
  description: string;
  highlights?: string[];
  tags?: string[];
}
