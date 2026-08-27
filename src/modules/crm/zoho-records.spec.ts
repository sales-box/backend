import {
  extractRecords,
  statusFromLeadStatus,
  toCrmContacts,
} from './zoho-records';

describe('extractRecords', () => {
  const record = { id: '1', Email: 'a@b.co' };

  it('reads the Zoho envelope', () => {
    expect(extractRecords({ data: [record] })).toEqual([record]);
  });

  it('reads a bare array', () => {
    expect(extractRecords([record])).toEqual([record]);
  });

  it('reads a JSON string', () => {
    expect(extractRecords(JSON.stringify({ data: [record] }))).toEqual([
      record,
    ]);
  });

  // MCP tools commonly answer with content blocks rather than a value.
  it('reads an MCP text content block', () => {
    expect(
      extractRecords([
        { type: 'text', text: JSON.stringify({ data: [record] }) },
      ]),
    ).toEqual([record]);
  });

  it('reads a nested content envelope', () => {
    expect(extractRecords({ content: { records: [record] } })).toEqual([
      record,
    ]);
  });

  // An import that returns nothing is recoverable; one that throws kills the
  // whole connect.
  it.each([null, undefined, 42, 'not json', {}, { data: null }])(
    'returns [] for %p rather than throwing',
    (payload) => {
      expect(extractRecords(payload)).toEqual([]);
    },
  );
});

describe('statusFromLeadStatus', () => {
  it.each([
    ['Not Contacted', 'new_inquiry'],
    ['Contacted', 'new_inquiry'],
    ['Pre-Qualified', 'qualified'],
    ['  qualified  ', 'qualified'],
  ])('maps %s to %s', (input, expected) => {
    expect(statusFromLeadStatus(input)).toBe(expected);
  });

  // A junk or lost lead is not a fresh enquiry and we have no status that says
  // so, so it must leave the existing value alone.
  it.each(['Junk Lead', 'Lost Lead', 'Not Qualified'])(
    'returns undefined for %s rather than resetting to new_inquiry',
    (input) => {
      expect(statusFromLeadStatus(input)).toBeUndefined();
    },
  );

  it.each([undefined, null, '', '   ', 42, 'constructor', 'toString'])(
    'returns undefined for %p',
    (input) => {
      expect(statusFromLeadStatus(input)).toBeUndefined();
    },
  );
});

describe('toCrmContacts', () => {
  it('maps a Contact, taking the company off the account object', () => {
    expect(
      toCrmContacts([
        {
          id: 'z-1',
          Email: 'jane@acme.co',
          First_Name: 'Jane',
          Last_Name: 'Doe',
          Account_Name: { name: 'Acme' },
        },
      ]),
    ).toEqual([
      {
        email: 'jane@acme.co',
        name: 'Jane Doe',
        company: 'Acme',
        crmId: 'z-1',
        status: undefined,
      },
    ]);
  });

  // Leads name the same field differently, and carry the lifecycle value.
  it('maps a Lead, taking the company off Company and the status off Lead_Status', () => {
    expect(
      toCrmContacts([
        {
          id: 'z-2',
          Email: 'bob@corp.io',
          Full_Name: 'Bob Jones',
          Company: 'Corp',
          Lead_Status: 'Pre-Qualified',
        },
      ]),
    ).toEqual([
      {
        email: 'bob@corp.io',
        name: 'Bob Jones',
        company: 'Corp',
        crmId: 'z-2',
        status: 'qualified',
      },
    ]);
  });

  it('prefers Full_Name over the name parts', () => {
    const [c] = toCrmContacts([
      { id: '1', Email: 'a@b.co', Full_Name: 'Full', First_Name: 'Part' },
    ]);
    expect(c.name).toBe('Full');
  });

  // A record with no email cannot be matched to an inbound sender, and one
  // with no id cannot be linked back to the CRM.
  const incomplete: Array<[Record<string, unknown>, string]> = [
    [{ id: '1' }, 'no email'],
    [{ Email: 'a@b.co' }, 'no id'],
    [{ id: '1', Email: '   ' }, 'blank email'],
  ];
  it.each(incomplete)('drops a record with %s', (record) => {
    expect(toCrmContacts([record])).toEqual([]);
  });
});
