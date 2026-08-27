import { Injectable, Logger } from '@nestjs/common';
import type { CrmContact, ICrmAdapter } from './crm.interface';

@Injectable()
export class MockCrmAdapter implements ICrmAdapter {
  private readonly logger = new Logger(MockCrmAdapter.name);

  getContactByEmail(email: string): Promise<{ id: string } | null> {
    if (email.startsWith('nonexistent') || email.includes('notfound')) {
      return Promise.resolve(null);
    }
    const safeEmail = email.replace('@', '-');
    return Promise.resolve({ id: `mock-contact-${safeEmail}` });
  }

  fetchContacts(): Promise<CrmContact[]> {
    // Two different statuses on purpose: the mock provider is the only way to
    // exercise the import without a live CRM, so it has to prove that status
    // travels rather than that a single value does.
    return Promise.resolve([
      {
        email: 'crm-user-1@acme.com',
        name: 'Alice Smith',
        company: 'Acme',
        crmId: 'mock-contact-crm-1',
        status: 'customer',
      },
      {
        email: 'crm-user-2@test.com',
        name: 'Bob Jones',
        company: 'TestCorp',
        crmId: 'mock-contact-crm-2',
        status: 'qualified',
      },
    ]);
  }
}
