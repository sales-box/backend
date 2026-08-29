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

  // The shape a real Zoho MCP server actually returns, captured from a live
  // server on 29 Aug. A single content object — not an array of them — whose
  // records sit inside a JSON string. The parser handled the array form and
  // returned nothing for this one, which is what made a Zoho connect report
  // success over an empty Clients page.
  describe("the live server's own shape", () => {
    const liveEnvelope = (records: unknown[]) => ({
      type: 'text',
      text: JSON.stringify({
        data: records,
        info: { per_page: 200, count: records.length, more_records: false },
      }),
      structuredContent: { data: records, status: 'success' },
    });

    it('reads records out of an MCP content object', () => {
      expect(extractRecords(liveEnvelope([record]))).toEqual([record]);
    });

    it('still finds them when structuredContent is absent', () => {
      const full = liveEnvelope([record]);
      const textOnly = { type: full.type, text: full.text };
      expect(extractRecords(textOnly)).toEqual([record]);
    });

    it('returns nothing for an empty result rather than throwing', () => {
      expect(extractRecords(liveEnvelope([]))).toEqual([]);
    });
  });

  // A key that exists but is null or empty must not end the search: the real
  // envelope carries several candidate keys and only one of them has the rows.
  it('keeps looking past a key that is present but empty', () => {
    expect(
      extractRecords({
        data: null,
        records: [],
        text: JSON.stringify({ data: [record] }),
      }),
    ).toEqual([record]);
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
      toCrmContacts(
        [
          {
            id: 'z-1',
            Email: 'jane@acme.co',
            First_Name: 'Jane',
            Last_Name: 'Doe',
            Account_Name: { name: 'Acme' },
          },
        ],
        'Contacts',
      ),
    ).toEqual([
      {
        email: 'jane@acme.co',
        name: 'Jane Doe',
        company: 'Acme',
        crmId: 'z-1',
        // Being in Contacts is itself the signal: converted and account-attached.
        status: 'qualified',
      },
    ]);
  });

  // Leads name the same field differently, and carry the lifecycle value.
  it('maps a Lead, taking the company off Company and the status off Lead_Status', () => {
    expect(
      toCrmContacts(
        [
          {
            id: 'z-2',
            Email: 'bob@corp.io',
            Full_Name: 'Bob Jones',
            Company: 'Corp',
            Lead_Status: 'Pre-Qualified',
          },
        ],
        'Leads',
      ),
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
    const [c] = toCrmContacts(
      [{ id: '1', Email: 'a@b.co', Full_Name: 'Full', First_Name: 'Part' }],
      'Contacts',
    );
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
    expect(toCrmContacts([record], 'Contacts')).toEqual([]);
  });

  // Reading only Lead_Status made the import say the opposite of the truth: a
  // qualified Contact landed on new_inquiry while an unqualified Lead could
  // land on qualified. The module carries the lifecycle now.
  describe('the module carries the lifecycle', () => {
    const person = { id: '1', Email: 'a@b.co', Full_Name: 'A B' };

    it('treats a Contact as qualified even with no status field', () => {
      expect(toCrmContacts([person], 'Contacts')[0].status).toBe('qualified');
    });

    it('leaves a Lead with no recognised status to the caller default', () => {
      expect(toCrmContacts([person], 'Leads')[0].status).toBeUndefined();
    });

    it('lets an explicit Lead_Status win over the module default', () => {
      const contacted = { ...person, Lead_Status: 'Contacted' };
      expect(toCrmContacts([contacted], 'Contacts')[0].status).toBe(
        'new_inquiry',
      );
    });

    it('does not claim a Contact is a customer — that needs a won deal', () => {
      expect(toCrmContacts([person], 'Contacts')[0].status).not.toBe(
        'customer',
      );
    });
  });
});
