export interface DecodedGmailHistory {
  emailAddress: string;
  historyId: string;
}

export interface NewMessagesResult {
  messageIds: string[];
  newHistoryId: string;
}

export interface NewSentThreadsResult {
  threadIds: string[];
  newHistoryId: string;
}
