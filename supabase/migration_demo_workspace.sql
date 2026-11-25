-- Run after the base schema and before enabling Supabase anonymous sign-ins.
BEGIN;

CREATE TABLE IF NOT EXISTS public.demo_workspaces (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);
ALTER TABLE public.demo_workspaces ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.demo_workspaces FROM PUBLIC, anon, authenticated;
GRANT INSERT ON public.demo_workspaces TO authenticated;

DROP POLICY IF EXISTS "Demo users can claim their workspace" ON public.demo_workspaces;
CREATE POLICY "Demo users can claim their workspace" ON public.demo_workspaces
  FOR INSERT TO authenticated WITH CHECK (
    user_id = (SELECT auth.uid())
    AND ((SELECT auth.jwt()) ->> 'is_anonymous') = 'true'
  );

DROP POLICY IF EXISTS "Notion settings require a permanent account" ON public.user_notion_settings;
CREATE POLICY "Notion settings require a permanent account" ON public.user_notion_settings
  AS RESTRICTIVE TO authenticated
  USING (((SELECT auth.jwt()) ->> 'is_anonymous') IS DISTINCT FROM 'true')
  WITH CHECK (((SELECT auth.jwt()) ->> 'is_anonymous') IS DISTINCT FROM 'true');

-- Protect both ends of these relationships when clients write directly.
DROP POLICY IF EXISTS "Pins must reference an owned highlight" ON public.pinned_highlights;
CREATE POLICY "Pins must reference an owned highlight" ON public.pinned_highlights
  AS RESTRICTIVE FOR INSERT TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.highlights h
            WHERE h.id = highlight_id AND h.user_id = (SELECT auth.uid()))
  );

DROP POLICY IF EXISTS "Updated assignments must reference an owned highlight" ON public.daily_summary_highlights;
CREATE POLICY "Updated assignments must reference an owned highlight" ON public.daily_summary_highlights
  AS RESTRICTIVE FOR UPDATE TO authenticated WITH CHECK (
    EXISTS (SELECT 1 FROM public.highlights h
            WHERE h.id = highlight_id AND h.user_id = (SELECT auth.uid()))
  );

CREATE OR REPLACE FUNCTION public.seed_demo_workspace(p_today date)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
-- Existing pin and review triggers refer to the public tables by name.
SET search_path = public, pg_temp
AS $$
DECLARE
  demo_user uuid := auth.uid();
  utc_today date := timezone('UTC', now())::date;
  month_start date := date_trunc('month', p_today::timestamp)::date;
  prior_review_day date := month_start - 7;
  earlier_review_day date := (month_start - interval '1 month')::date - 7;
  category_ids uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 5));
  highlight_ids uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 21));
BEGIN
  IF demo_user IS NULL OR (auth.jwt() ->> 'is_anonymous') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'An anonymous demo session is required' USING ERRCODE = '42501';
  END IF;
  IF p_today IS NULL OR p_today NOT BETWEEN utc_today - 1 AND utc_today + 1 THEN
    RAISE EXCEPTION 'A current local date is required' USING ERRCODE = '22023';
  END IF;

  -- A concurrent request waits for this insert. A failed seed rolls back the
  -- claim and all its sample data, so the same session can safely retry.
  INSERT INTO public.demo_workspaces (user_id) VALUES (demo_user)
  ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  INSERT INTO public.categories (id, user_id, name, color) VALUES
    (category_ids[1], demo_user, 'Learning', '#6366f1'),
    (category_ids[2], demo_user, 'Design', '#0ea5e9'),
    (category_ids[3], demo_user, 'Focus', '#10b981'),
    (category_ids[4], demo_user, 'Teamwork', '#f59e0b'),
    (category_ids[5], demo_user, 'Quotes', '#8b5cf6');

  INSERT INTO public.highlights (id, user_id, text, html_content, source, created_at, archived)
  SELECT highlight_ids[n], demo_user, body, COALESCE(html, '<p>' || body || '</p>'),
         source, LEAST(now(), (earlier_review_day - n + time '12:00') AT TIME ZONE 'UTC'), archived
  FROM (VALUES
    (1, 'Close the book before you check your notes. Recalling an idea from memory tells you what stuck and what needs another pass.',
      '<p><strong>Close the book before you check your notes.</strong> Recalling an idea from memory tells you what stuck and what needs another pass.</p>', 'Learning journal', false),
    (2, 'A useful empty state answers two questions: What belongs here? What can I do next?',
      '<p>A useful empty state answers two questions:</p><ul><li>What belongs here?</li><li>What can I do next?</li></ul>', 'Interface design notes', false),
    (3, 'Before ending a focus block, write the next concrete step. Tomorrow you can start with the work itself.',
      NULL, 'Deep work experiments', false),
    (4, 'Record the reason for a decision while the trade-offs are fresh. Future teammates will need that context when the constraints change.',
      NULL, 'Team handbook', false),
    (5, 'Ask someone to show you the last time they did the task. The details that surface in a real example rarely make it into a general answer.',
      NULL, 'Research interview notes', false),
    (6, 'Turn a highlight into a question you can answer later. A second look becomes retrieval practice.',
      NULL, 'Learning journal', false),
    (7, 'Group similar tasks into one session. A single context switch costs less than five small interruptions.',
      NULL, 'Deep work experiments', false),
    (8, 'Write meeting notes in three parts: the decision, the owner, and the next check-in.',
      NULL, 'Team handbook', false),
    (9, 'Start design critique by naming the user and the task. That gives everyone the same criteria for feedback.',
      NULL, 'Interface design notes', false),
    (10, 'After you solve a problem, explain the trade-off in plain language. If the explanation feels slippery, revisit the part you skipped.',
      NULL, 'Learning journal', false),
    (11, 'When a project feels stalled, name the smallest experiment that would change your mind.',
      NULL, 'Research interview notes', false),
    (12, 'Set aside Friday afternoons to sort the old workshop notes.', NULL, 'Workshop planning', true),
    (13, 'Keep a checklist for the launch dry run.', NULL, 'Launch retrospective', true)
  ) AS notes(n, body, html, source, archived);

  INSERT INTO public.highlights (id, user_id, text, html_content, author, source, created_at)
  SELECT highlight_ids[n], demo_user, body, '<blockquote><p>' || body || '</p></blockquote>',
         author, source, now() - n * interval '1 hour'
  FROM (VALUES
    -- https://jamesclear.com/3-2-1/january-2-2020
    (14, 'You do not rise to the level of your goals. You fall to the level of your systems.',
      'James Clear', '3-2-1 Newsletter, January 2, 2020'),
    -- https://paulgraham.com/greatwork.html
    (15, 'The best questions grow in the answering.',
      'Paul Graham', 'How to Do Great Work'),
    -- https://aliabdaal.com/newsletter/what-does-it-actually-mean-to-be-efficient/
    (16, 'Enjoyment really does seem to be a form of efficiency.',
      'Ali Abdaal', 'LifeNotes, What Does It Actually Mean to Be Efficient?'),
    -- https://dailystoic.com/dont-let-worry-get-better/
    (17, 'We suffer more often in imagination than in reality.',
      'Seneca', 'Letter 13, featured in Daily Stoic'),
    -- https://tim.blog/wp-content/uploads/2020/01/17-Questions-That-Changed-My-Life.pdf
    (18, 'What would this look like if it were easy?',
      'Tim Ferriss', '17 Questions That Changed My Life'),
    -- https://tim.blog/2015/08/07/5-bullet-friday/
    (19, 'Innovation is saying no to 1,000 things.',
      'Steve Jobs', 'Featured in Tim Ferriss’s 5-Bullet Friday'),
    -- https://www.gutenberg.org/files/2944/2944-h/2944-h.htm
    (20, 'Nothing great was ever achieved without enthusiasm.',
      'Ralph Waldo Emerson', 'Circles'),
    -- https://libraryweb.org/~digitized/books/Two_Speeches_by_Frederick_Douglass.pdf
    (21, 'If there is no struggle there is no progress.',
      'Frederick Douglass', 'West India Emancipation speech')
  ) AS quotes(n, body, author, source);

  INSERT INTO public.highlight_categories (highlight_id, category_id)
  SELECT highlight_ids[n], category_ids[category]
  FROM (VALUES (1, 1), (2, 2), (3, 3), (4, 4), (5, 2), (6, 1), (7, 3),
               (8, 4), (9, 2), (9, 4), (10, 1), (11, 2), (11, 3), (12, 3), (13, 4),
               (14, 1), (15, 1), (16, 3), (17, 3), (18, 3), (19, 2), (20, 3), (21, 4),
               (14, 5), (15, 5), (16, 5), (17, 5), (18, 5), (19, 5), (20, 5), (21, 5))
    AS tags(n, category);

  INSERT INTO public.highlight_links (from_highlight_id, to_highlight_id)
  SELECT highlight_ids[source], highlight_ids[target]
  FROM (VALUES (1, 6), (1, 10), (2, 9), (3, 7), (4, 8), (5, 11), (9, 4),
               (14, 3), (15, 5), (16, 20), (18, 11), (19, 2))
    AS links(source, target);

  INSERT INTO public.pinned_highlights (user_id, highlight_id)
  VALUES (demo_user, highlight_ids[2]), (demo_user, highlight_ids[4]),
         (demo_user, highlight_ids[14]);

  -- Demo accounts use the app's default monthly cycle. Schedule from the
  -- visitor's local day and keep past ratings on their original assignment days.
  INSERT INTO public.daily_summaries (user_id, date)
  SELECT demo_user, day
  FROM unnest(ARRAY[p_today - 1, p_today, p_today + 1, p_today + 2, p_today + 3,
                    p_today + 4, prior_review_day, earlier_review_day]) AS days(day);

  WITH assignments(n, day, rating) AS (
    VALUES (1, p_today, NULL::text), (2, p_today, NULL), (3, p_today, NULL), (4, p_today, NULL),
           (14, p_today, NULL), (15, p_today, NULL),
           (5, p_today + 1, NULL), (6, p_today + 1, NULL), (7, p_today + 2, NULL),
           (8, p_today - 1, NULL), (9, p_today - 1, 'med'),
           (10, p_today + 3, NULL), (11, p_today + 4, NULL),
           (16, p_today + 1, NULL), (17, p_today + 2, NULL), (18, p_today + 2, NULL),
           (19, p_today + 3, NULL), (20, p_today + 4, NULL), (21, p_today + 4, NULL),
           (1, prior_review_day, 'high'),
           (12, prior_review_day, 'low'), (12, earlier_review_day, 'low')
  )
  INSERT INTO public.daily_summary_highlights (daily_summary_id, highlight_id, rating, rated_at)
  SELECT ds.id, highlight_ids[n], rating,
         CASE WHEN rating IS NOT NULL THEN (day + time '12:00') AT TIME ZONE 'UTC' END
  FROM assignments JOIN public.daily_summaries ds ON ds.date = assignments.day
  WHERE ds.user_id = demo_user;

  INSERT INTO public.highlight_months_reviewed (highlight_id, month_year, created_at)
  SELECT dsh.highlight_id, to_char(ds.date, 'YYYY-MM'), dsh.rated_at
  FROM public.daily_summary_highlights dsh
  JOIN public.daily_summaries ds ON ds.id = dsh.daily_summary_id
  WHERE ds.user_id = demo_user AND dsh.rating IS NOT NULL;

  UPDATE public.highlights h
  SET average_rating = stats.average_rating,
      rating_count = stats.rating_count,
      last_resurfaced = stats.last_resurfaced
  FROM (
    SELECT dsh.highlight_id,
           avg(CASE dsh.rating WHEN 'low' THEN 1 WHEN 'med' THEN 2 WHEN 'high' THEN 3 END) AS average_rating,
           count(*) AS rating_count,
           max(dsh.rated_at) AS last_resurfaced
    FROM public.daily_summary_highlights dsh
    JOIN public.daily_summaries ds ON ds.id = dsh.daily_summary_id
    WHERE ds.user_id = demo_user AND dsh.rating IS NOT NULL
    GROUP BY dsh.highlight_id
  ) stats
  WHERE h.id = stats.highlight_id AND h.user_id = demo_user;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_demo_workspace(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_demo_workspace(date) TO authenticated;

COMMIT;
