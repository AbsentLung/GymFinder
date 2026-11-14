-- Essential reference rows a fresh database needs to actually function -
-- not sample gym data. Gyms get populated live via search (Overpass) the
-- same way they do in the real app; there's no reason to ship a seed
-- dump of someone else's gym data for a friend setting this up fresh.

INSERT INTO gym_submission_statuses (id, label) VALUES
  (1, 'Pending Bot Approval'),
  (2, 'Pending Admin Approval'),
  (3, 'Approved'),
  (4, 'Disapproved')
ON CONFLICT (id) DO NOTHING;

-- id 0 is the bot sentinel referenced by gym_submissions.approved_by when
-- the bot sweep auto-approves a submission (server/index.js's
-- runBotSweep) - without this row, that UPDATE has nothing valid to
-- point at.
INSERT INTO admins (id, name) VALUES (0, 'Bot')
ON CONFLICT (id) DO NOTHING;

-- Mirrors GYM_CATEGORIES in server/lib.js exactly - a gym's categories
-- live in the gym_categories join table (a gym can have several), keyed
-- against this fixed, generic list rather than whatever free-text
-- phrase a scrape happened to produce.
INSERT INTO categories (id, label) VALUES
  (1, 'Traditional'),
  (2, 'Group'),
  (3, 'Yoga'),
  (4, 'Bouldering'),
  (5, 'Swimming'),
  (6, 'Luxury'),
  (7, 'MMA'),
  (8, '24hr'),
  (9, 'Outdoor'),
  (10, 'Sports'),
  (11, 'CrossFit'),
  (12, 'Hyrox'),
  (13, 'HIIT'),
  (14, 'Personal Trainer'),
  (15, 'Pilates')
ON CONFLICT (id) DO NOTHING;
