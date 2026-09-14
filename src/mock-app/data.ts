export interface Member {
  id: string;
  name: string;
  checking: number;
  savings: number;
  flaggedForReview: boolean;
}

export const members: Record<string, Member> = {
  "10001": { id: "10001", name: "John Smith", checking: 2340.12, savings: 15200.55, flaggedForReview: false },
  "10002": { id: "10002", name: "Jane Doe", checking: 500.0, savings: 100.0, flaggedForReview: false },
  "10003": { id: "10003", name: "Robert Lee", checking: 8120.4, savings: 42000.0, flaggedForReview: true },
};

export interface SubAccount {
  memberId: string;
  type: string;
  initialDeposit: number;
  nickname: string;
}

export const MIN_INITIAL_DEPOSIT = 25;

// Simple in-memory session store: token -> memberId being serviced.
export const sessions = new Map<string, { username: string }>();
