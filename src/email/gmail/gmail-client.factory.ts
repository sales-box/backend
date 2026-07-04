import { Injectable } from "@nestjs/common";
import { google, gmail_v1 } from "googleapis";

@Injectable()
export class GmailClientFactory {
    // TODO: Integrate with AuthService to fetch the token for the given emailAccount
    // and with ConfigStore to fetch the clientId and clientSecret for the Gmail API.
    // constructor(private readonly AuthService: any) {} 

    async createClient(emailAccount: string): Promise<gmail_v1.Gmail> {
        // TODO: Uncomment when AuthService is integrated
        // const userCredentials = await this.AuthService.getUserCredentials(emailAccount);
        const userCredentials = {};
        
        const auth = new google.auth.OAuth2({
            clientId: process.env.GMAIL_CLIENT_ID,
            clientSecret: process.env.GMAIL_CLIENT_SECRET,
        });

        auth.setCredentials(userCredentials);

        return google.gmail({ version: "v1", auth });
    }
}