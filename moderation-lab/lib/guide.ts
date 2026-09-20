/**
 * Interview guide content, as plain TypeScript (not a DB table) -- matches
 * the Python project's precedent (common/guides/*.py) and keeps guides
 * versioned with the code rather than requiring a migration to add one.
 *
 * Several "everyday" guides exist (grocery shopping, commuting, streaming,
 * fitness) -- simple, personal topics anyone can be genuinely interviewed
 * on on the spot, for testing whether the moderator *feels* good without a
 * tester having to act out a persona, which is its own confound. Having
 * several matters for a real reason found in practice: once a tester has
 * heard one guide's questions, their answers on a repeat call stop being
 * spontaneous (they're anticipating what's coming), which contaminates
 * any comparison between architectures. The guide is picked per call from
 * the manual-test UI (app/page.tsx) precisely so a fresh one is always
 * available -- see getGuide() below and how it threads through
 * ArchitectureRequest.guide rather than being a fixed, deploy-time
 * constant. `biopharma` is the real target-domain topic, for testing
 * against actual personas later. Adding another guide is just adding
 * another export and an entry in the GUIDES registry below.
 *
 * Each guide separates two things real market research keeps separate on
 * purpose (the sponsor-blind practice: a due-diligence interview says
 * "I'm gathering input on what it takes to succeed in this space," not
 * "I'm evaluating whether to acquire a company here"):
 * - `statedPurpose` -- the honest-but-partial framing a real respondent
 *   would actually be told. `app/page.tsx` shows this *before* the call,
 *   and it's what the moderator's own opening leans on -- so the human
 *   tester goes in the same way a real respondent would: informed, but
 *   not read into the actual strategic question.
 * - `researchObjective` -- the real business decision this study exists to
 *   inform. `lib/architectures/baseline.ts` folds a condensed version into
 *   the moderator's own system prompt (private context, never spoken), so
 *   it can recognize when an answer hasn't actually resolved what the
 *   study needs to know, not just execute a question list. `app/page.tsx`
 *   only reveals this *after* the call ends, so the tester can retro-
 *   spectively judge whether the moderator actually got there ("did it
 *   establish whether cost, time, or decision fatigue is the real
 *   barrier?") without that knowledge contaminating their own answers
 *   while playing the respondent.
 *
 * Questions are given real texture (a forced-choice, a rating-then-why, an
 * open question designed to surface an unplanned thread, a concept
 * reaction) rather than generic ones -- a thin guide makes every
 * architecture look shallow regardless of how well it actually reasons,
 * since there's nothing worth probing into. Still a ~10-minute
 * conversation, not an elaborate one.
 */
export type GuideQuestion = {
  topic: string;
  ask: string;
  targetMinutes: number;
  probes?: string[];
  /** Ask them to state a number verbally (no tap UI in a voice call), then
   * immediately probe why -- rating-then-why sequencing, not rating alone. */
  rating?: { prompt: string; scale: string };
  /** Guidance for the moderator on what this question is really testing --
   * not read aloud, just steering. */
  note?: string;
  /**
   * An explicit stopping condition, not just context: the moderator is
   * instructed to keep probing this topic -- using its own judgment,
   * drawing on `probes` if helpful -- until this is genuinely satisfied,
   * rather than treating a single scripted question (or a fixed list of
   * probes) as the whole job. Optional because most of the app's other
   * guides don't have one yet; only oncology_tih uses this so far, added
   * after a real observed failure: splitting a compound question into a
   * probe made that probe skippable ("if needed"), and a real test call
   * skipped a probe (patient mix) the guide actually wanted covered every
   * time. A goal is meant to restore that reliability without reintroducing
   * the compounding the probe split was fixing -- the moderator still asks
   * one thing at a time, it just doesn't move on until the goal is met (or
   * it's genuinely out of time for this topic).
   */
  goal?: string;
};

export type Guide = {
  studyTopic: string;
  targetDurationMinutes: number;
  /** Honest-but-partial framing shown to the tester before the call, and
   * what the moderator's opening leans on -- see module docstring. */
  statedPurpose: string;
  /** The real business decision this study informs -- private until after
   * the call. See module docstring. */
  researchObjective: string;
  openingScript: string;
  closingScript: string;
  questions: GuideQuestion[];
};

export const BIOPHARMA_GUIDE: Guide = {
  studyTopic:
    "How biopharma market-research teams currently run qualitative interviews, and where AI could help.",
  targetDurationMinutes: 10,
  statedPurpose:
    "We're doing research on how market research and insights teams in biopharma companies work today " +
    "-- including how they think about new tools and approaches, AI included, that might change that " +
    "over time. There's no wrong answer, we're just trying to understand real day-to-day practice.",
  researchObjective:
    "You're being interviewed on behalf of an AI-native market-research startup deciding whether " +
    "experienced biopharma insights professionals would actually trust and adopt AI-moderated " +
    "qualitative interviews as part of their real research toolkit -- not just find the idea " +
    "interesting in the abstract. The team needs real answers to: (1) is the biggest barrier in their " +
    "current process really speed, cost, or depth of insight -- because that determines whether an " +
    "AI-moderated approach even addresses their actual pain; (2) how much slack do they feel they " +
    "genuinely have today, and is there real appetite for something different; (3) what would it " +
    "concretely take for them to trust an AI moderator with a real study, not a toy pilot. As the " +
    "evaluator, watch whether the moderator actually pins down clear answers to these, not just " +
    "whether the conversation feels pleasant.",
  openingScript:
    "Hi, thanks so much for joining today. I'd love to hear about how your team runs market research " +
    "and thinks about AI's role in it — there are no wrong answers here, I'm just trying to understand " +
    "how this actually works day to day. Ready to dive in?",
  closingScript:
    "This has been genuinely useful, thank you for being so candid. That's everything I wanted to cover " +
    "— have a great rest of your day.",
  questions: [
    {
      topic: "warm-up / role",
      ask: "To start, tell me a bit about your role and the kind of research your team runs most often.",
      targetMinutes: 1.5,
      probes: ["What's a project you worked on recently?", "Who do you usually do this for internally?"],
      note: "Quick warm-up -- get a concrete, specific example on the table early so later questions have something real to anchor to.",
    },
    {
      topic: "current process",
      ask: "Walk me through how a typical qualitative study actually gets commissioned and run, start to finish.",
      targetMinutes: 2,
      probes: [
        "Where does the business question first come from?",
        "Who's involved at each step, and where does the most time actually go?",
        "How much of that is genuinely necessary vs. just how it's always been done?",
      ],
    },
    {
      topic: "biggest friction point (forced choice)",
      ask:
        "If you had to pick just one — is the bigger problem with your current process the speed it takes, " +
        "the cost, or the depth of insight you actually get out of it? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific time that actually bit you.",
        "What would 'fixed' even look like for that?",
      ],
      note: "This is the core of the research objective -- a vague 'all three are frustrating' answer isn't a real answer, worth pushing past.",
    },
    {
      topic: "process health (rating + why)",
      ask:
        "On a scale of 1 to 10, how well is your current research process keeping up with how fast the " +
        "business actually needs answers?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How well is your current research process keeping up with how fast the business needs answers?",
        scale: "1 (not at all) to 10 (perfectly)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' behind it -- the number alone is not the data point that matters.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a research project in the last year that didn't go the way you expected.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "What did you do differently afterward, if anything?"],
      note:
        "Deliberately open-ended and off-guide -- whatever they bring up here (a vendor issue, a bad " +
        "respondent sample, a stakeholder fight, something else entirely) is worth actually pulling on for " +
        "a turn or two before moving to the next topic, even though it isn't itself a scripted question.",
    },
    {
      topic: "AI trust (concept reaction)",
      ask:
        "Now imagine a service where an AI, not a human, actually moderates a live voice interview with " +
        "your target respondents -- would you seriously consider using that for a real study, or not?",
      targetMinutes: 1.5,
      probes: [
        "What would it concretely take for you to trust it with something that actually matters?",
        "What's a claim you've heard from a vendor in this space that you didn't buy?",
      ],
      note: "This is the direct payoff question -- get a real yes/no-leaning reaction and the concrete condition behind it, not just polite interest.",
    },
  ],
};

export const EVERYDAY_GUIDE: Guide = {
  studyTopic: "How people decide what to eat day-to-day — grocery shopping, meal planning, and cooking habits.",
  targetDurationMinutes: 10,
  statedPurpose:
    "We're doing some research on how people currently plan meals and shop for groceries -- everyday " +
    "habits, what works, what's annoying -- for a company that's exploring new tools in this space. " +
    "No wrong answers, just curious how it really works for you.",
  researchObjective:
    "You're being interviewed on behalf of Homeplate, a meal-kit and grocery-delivery subscription " +
    "company. Homeplate's product team is deciding whether to build a new, lower-cost 'Quick Plan' " +
    "tier -- AI-assisted weekly meal planning and a ready-to-order grocery list, without the full " +
    "meal-kit boxes -- aimed specifically at people who currently do NOT use any meal-kit or " +
    "grocery-delivery service. Before building it, they need real answers to: (1) is this person's " +
    "current process real deliberate choice, or just habit/inertia -- inertia is much harder to " +
    "unseat than a genuine unmet need; (2) what's actually the bigger barrier -- cost, time, or just " +
    "not knowing what to make (decision fatigue) -- because the answer changes whether a cheaper tier " +
    "alone would even move anyone, versus needing to solve decision fatigue directly; (3) how much " +
    "real appetite exists for something new versus 'it's not broken, don't fix it'; (4) presented with " +
    "the actual Quick Plan concept, would *this specific person* actually try it, and if not, why not. " +
    "As the evaluator, watch whether the moderator actually pins down clear answers to these -- " +
    "especially #2 and #4 -- not just whether the conversation feels pleasant.",
  openingScript:
    "Hi, thanks for chatting with me today. I'm doing some research on behalf of a company exploring " +
    "new tools for weekly meal planning and grocery shopping, and I want to understand how you " +
    "actually handle that today — no wrong answers, I'm just curious how it really works for you. " +
    "Ready to dive in?",
  closingScript:
    "This was genuinely useful, thank you for walking me through all of that. That's everything I " +
    "wanted to cover — have a great rest of your day.",
  questions: [
    {
      topic: "warm-up",
      ask: "Tell me about your week so far from a food standpoint — mostly cooking, ordering in, a mix?",
      targetMinutes: 1,
      probes: ["What did you actually eat yesterday?", "Is that a pretty typical day for you?"],
      note: "Quick warm-up -- get something concrete and specific on the table early.",
    },
    {
      topic: "current process (habit vs. deliberate choice)",
      ask: "Walk me through how you actually decide what to buy or make in a typical week.",
      targetMinutes: 1.5,
      probes: [
        "Do you plan ahead or figure it out day to day?",
        "Where does most of the effort or time actually go?",
        "Is that a real decision you're making each week, or mostly just habit at this point?",
      ],
      note: "Trying to establish habit/inertia vs. genuine unmet need -- that distinction matters a lot for whether a new tool would actually get adopted.",
    },
    {
      topic: "core barrier (forced choice)",
      ask:
        "If you had to pick just one — is the bigger friction point for you the cost, the time it takes, " +
        "or just not knowing what you want? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific time that was actually annoying because of it.",
        "What would 'fixed' actually look like for you?",
      ],
      note:
        "This is the single most important question in the whole guide -- the answer decides whether a " +
        "cheaper option alone would move this person, or whether the real problem is decision fatigue " +
        "that price can't fix. A vague 'a bit of everything' answer isn't a real answer, worth pushing past.",
    },
    {
      topic: "satisfaction (rating + why)",
      ask: "On a scale of 1 to 10, how satisfied are you with how you currently handle food and groceries?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How satisfied are you with how you currently handle food and groceries?",
        scale: "1 (not at all) to 10 (couldn't be better)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' -- gauging real appetite for change vs. complacency.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a specific time your food plan for the week completely fell apart, or a meal that really surprised you.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "Did it change how you do things afterward?"],
      note:
        "Deliberately open-ended -- whatever story comes up here is worth actually pulling on for a turn " +
        "or two before moving on. A concrete failure moment here is often the real trigger that would " +
        "make someone switch to something new, worth more than a hypothetical.",
    },
    {
      topic: "Quick Plan concept reaction",
      ask:
        "Here's an idea: imagine a service that, every week, automatically builds you a meal plan and a " +
        "ready-to-order grocery list based on what you like — no full meal-kit boxes, just the planning " +
        "and the list, for a lot less than a meal-kit subscription costs. Would you actually try that, or not?",
      targetMinutes: 2,
      probes: [
        "What specifically would make you say yes, or what's holding you back?",
        "Would that actually solve the friction point you picked earlier, or not really?",
      ],
      note:
        "This is the direct payoff question the whole study exists to answer -- get a real yes/no-leaning " +
        "reaction and the concrete reason behind it, and explicitly connect it back to whichever barrier " +
        "they picked earlier (cost/time/decision fatigue) rather than treating it as a fresh question.",
    },
  ],
};

export const COMMUTE_GUIDE: Guide = {
  studyTopic: "How people get to work or school day-to-day, and how they decide on that.",
  targetDurationMinutes: 10,
  statedPurpose:
    "We're doing some research on how people currently get to work or school -- everyday commuting " +
    "habits, what works, what's annoying -- for a company exploring new options in this space. No " +
    "wrong answers, just curious how it really works for you.",
  researchObjective:
    "You're being interviewed on behalf of RideBundle, a startup considering a single monthly " +
    "subscription that bundles transit passes, bikeshare, and a handful of on-demand rideshare credits " +
    "for the days transit or biking doesn't work. Before building it, they need real answers to: (1) is " +
    "this person's current commute mode real deliberate choice, or just habit/inertia -- inertia is " +
    "much harder to unseat than a genuine unmet need; (2) what's actually the bigger barrier with their " +
    "current commute -- cost, time/reliability, or comfort/convenience -- because the answer changes " +
    "whether a cheaper bundle alone would move anyone, versus needing to solve reliability or comfort " +
    "directly; (3) how much real appetite exists for something new versus 'it works fine, don't fix " +
    "it'; (4) presented with the actual bundle concept, would *this specific person* actually switch, " +
    "and if not, why not. As the evaluator, watch whether the moderator actually pins down clear " +
    "answers to these -- especially #2 and #4 -- not just whether the conversation feels pleasant.",
  openingScript:
    "Hi, thanks for chatting with me today. I'm doing some research on behalf of a company exploring " +
    "new commuting options, and I want to understand how you actually get around day to day — no " +
    "wrong answers, I'm just curious how it really works for you. Ready to dive in?",
  closingScript:
    "This was genuinely useful, thank you for walking me through all of that. That's everything I " +
    "wanted to cover — have a great rest of your day.",
  questions: [
    {
      topic: "warm-up",
      ask: "Tell me about how you got to work or school today, start to finish.",
      targetMinutes: 1,
      probes: ["Is that pretty typical, or did something make today different?", "How long does that usually take?"],
      note: "Quick warm-up -- get something concrete and specific on the table early.",
    },
    {
      topic: "current process (habit vs. deliberate choice)",
      ask: "Walk me through how you actually ended up commuting this way in the first place.",
      targetMinutes: 1.5,
      probes: [
        "Did you consider other options at the time, or was this just the obvious default?",
        "Have you re-evaluated it since, or is it mostly set-and-forget at this point?",
      ],
      note: "Trying to establish habit/inertia vs. genuine deliberate choice -- that distinction matters a lot for whether a new option would actually get adopted.",
    },
    {
      topic: "core barrier (forced choice)",
      ask:
        "If you had to pick just one — is the bigger problem with your commute the cost, the time and " +
        "reliability, or just the comfort and convenience of it? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific commute that was actually bad because of it.",
        "What would 'fixed' actually look like for you?",
      ],
      note:
        "This is the single most important question in the whole guide -- the answer decides whether a " +
        "cheaper bundle alone would move this person, or whether the real problem is reliability/comfort " +
        "that price can't fix. A vague 'it's all a bit annoying' answer isn't a real answer, worth pushing past.",
    },
    {
      topic: "satisfaction (rating + why)",
      ask: "On a scale of 1 to 10, how satisfied are you with how you currently commute?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How satisfied are you with how you currently commute?",
        scale: "1 (not at all) to 10 (couldn't be better)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' -- gauging real appetite for change vs. complacency.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a specific commute that went really wrong, or really surprised you.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "Did it change how you commute afterward?"],
      note:
        "Deliberately open-ended -- whatever story comes up here is worth actually pulling on for a turn " +
        "or two before moving on. A concrete bad-day story is often the real trigger that would make " +
        "someone switch to something new, worth more than a hypothetical.",
    },
    {
      topic: "RideBundle concept reaction",
      ask:
        "Here's an idea: imagine one monthly subscription that includes your transit pass, a bikeshare " +
        "membership, and a handful of rideshare credits for the days neither of those works — all for " +
        "less than what you'd pay for those separately. Would you actually switch to that, or not?",
      targetMinutes: 2,
      probes: [
        "What specifically would make you say yes, or what's holding you back?",
        "Would that actually solve the friction point you picked earlier, or not really?",
      ],
      note:
        "This is the direct payoff question the whole study exists to answer -- get a real yes/no-leaning " +
        "reaction and the concrete reason behind it, and explicitly connect it back to whichever barrier " +
        "they picked earlier (cost/reliability/comfort) rather than treating it as a fresh question.",
    },
  ],
};

export const STREAMING_GUIDE: Guide = {
  studyTopic: "How people decide what to watch, and how they manage their streaming subscriptions.",
  targetDurationMinutes: 10,
  statedPurpose:
    "We're doing some research on how people currently decide what to watch and manage streaming " +
    "subscriptions -- everyday habits, what works, what's annoying -- for a company exploring new " +
    "tools in this space. No wrong answers, just curious how it really works for you.",
  researchObjective:
    "You're being interviewed on behalf of Pickr, a startup considering a single cross-platform layer " +
    "that recommends what to watch across every streaming service you already subscribe to, instead of " +
    "browsing each app separately. Before building it, they need real answers to: (1) is the bigger " +
    "problem actually choice paralysis (too much to sort through) or subscription cost/overlap " +
    "(paying for services barely used) -- because the answer changes whether a recommendation layer " +
    "alone solves it, versus needing to help people cut subscriptions instead; (2) is their current " +
    "browsing routine something they've actively chosen, or just habit/inertia; (3) how much real " +
    "appetite exists for something new versus 'it's fine, I'll just keep scrolling'; (4) presented with " +
    "the actual concept, would *this specific person* actually use it. As the evaluator, watch whether " +
    "the moderator actually pins down clear answers to these -- especially #1 and #4 -- not just " +
    "whether the conversation feels pleasant.",
  openingScript:
    "Hi, thanks for chatting with me today. I'm doing some research on behalf of a company exploring " +
    "new tools for streaming and watching TV, and I want to understand how you actually handle that " +
    "today — no wrong answers, I'm just curious how it really works for you. Ready to dive in?",
  closingScript:
    "This was genuinely useful, thank you for walking me through all of that. That's everything I " +
    "wanted to cover — have a great rest of your day.",
  questions: [
    {
      topic: "warm-up",
      ask: "Tell me about the last thing you watched — how did you end up picking that?",
      targetMinutes: 1,
      probes: ["How long did it take you to settle on that?", "Is that pretty typical for how you decide?"],
      note: "Quick warm-up -- get something concrete and specific on the table early.",
    },
    {
      topic: "current process (habit vs. deliberate choice)",
      ask: "Walk me through how you actually decide what to watch on a typical night.",
      targetMinutes: 1.5,
      probes: [
        "Do you check a specific app first, or scroll around several?",
        "Is that a real decision each time, or mostly just habit at this point?",
      ],
      note: "Trying to establish habit/inertia vs. genuine active decision-making -- that distinction matters a lot for whether a new tool would actually get adopted.",
    },
    {
      topic: "core barrier (forced choice)",
      ask:
        "If you had to pick just one — is the bigger problem too many options to sort through, or paying " +
        "for subscriptions you don't really get your money's worth from? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other?",
        "Tell me about a specific time that was actually annoying because of it.",
        "What would 'fixed' actually look like for you?",
      ],
      note:
        "This is the single most important question in the whole guide -- the answer decides whether a " +
        "recommendation layer alone would move this person, or whether the real problem is subscription " +
        "cost that a better recommender can't fix. A vague 'both, I guess' answer isn't a real answer, " +
        "worth pushing past.",
    },
    {
      topic: "satisfaction (rating + why)",
      ask: "On a scale of 1 to 10, how satisfied are you with how you currently find things to watch?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How satisfied are you with how you currently find things to watch?",
        scale: "1 (not at all) to 10 (couldn't be better)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' -- gauging real appetite for change vs. complacency.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a time you spent way longer than you wanted to just deciding what to watch, or gave up entirely.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "Did it change how you do things afterward?"],
      note:
        "Deliberately open-ended -- whatever story comes up here is worth actually pulling on for a turn " +
        "or two before moving on. A concrete frustration moment here is often the real trigger that would " +
        "make someone try something new, worth more than a hypothetical.",
    },
    {
      topic: "Pickr concept reaction",
      ask:
        "Here's an idea: imagine one app that looks across every streaming service you already pay for " +
        "and just tells you the best thing to watch tonight, so you never have to browse each one " +
        "separately. Would you actually use that, or not?",
      targetMinutes: 2,
      probes: [
        "What specifically would make you say yes, or what's holding you back?",
        "Would that actually solve the friction point you picked earlier, or not really?",
      ],
      note:
        "This is the direct payoff question the whole study exists to answer -- get a real yes/no-leaning " +
        "reaction and the concrete reason behind it, and explicitly connect it back to whichever barrier " +
        "they picked earlier (choice paralysis/cost) rather than treating it as a fresh question.",
    },
  ],
};

export const FITNESS_GUIDE: Guide = {
  studyTopic: "How people decide on and actually stick with an exercise routine.",
  targetDurationMinutes: 10,
  statedPurpose:
    "We're doing some research on how people currently approach exercise and fitness -- everyday " +
    "habits, what works, what's annoying -- for a company exploring new tools in this space. No wrong " +
    "answers, just curious how it really works for you.",
  researchObjective:
    "You're being interviewed on behalf of Coach, a fitness app deciding whether to build AI-adaptive " +
    "coaching -- a plan that adjusts week to week based on what you actually did, instead of a fixed " +
    "program. Before building it, they need real answers to: (1) is this person's current routine (or " +
    "lack of one) real deliberate choice, or just inertia; (2) what's actually the bigger barrier -- not " +
    "having enough time, not knowing what to actually do (program design), or just not staying " +
    "motivated -- because the answer changes whether adaptive coaching even addresses the real problem, " +
    "versus needing something else entirely; (3) how much real appetite exists for something new versus " +
    "'I've tried enough apps already'; (4) presented with the actual concept, would *this specific " +
    "person* actually trust and try AI coaching, and if not, why not. As the evaluator, watch whether " +
    "the moderator actually pins down clear answers to these -- especially #2 and #4 -- not just " +
    "whether the conversation feels pleasant.",
  openingScript:
    "Hi, thanks for chatting with me today. I'm doing some research on behalf of a company exploring " +
    "new tools for exercise and fitness, and I want to understand how you actually approach that today " +
    "— no wrong answers, I'm just curious how it really works for you. Ready to dive in?",
  closingScript:
    "This was genuinely useful, thank you for walking me through all of that. That's everything I " +
    "wanted to cover — have a great rest of your day.",
  questions: [
    {
      topic: "warm-up",
      ask: "Tell me about the last time you exercised — what did you do, and how did you decide to do that?",
      targetMinutes: 1,
      probes: ["Is that pretty typical for you?", "How often would you say that happens in a normal week?"],
      note: "Quick warm-up -- get something concrete and specific on the table early.",
    },
    {
      topic: "current process (habit vs. deliberate choice)",
      ask: "Walk me through how you actually decide what to do for exercise in a typical week, if anything.",
      targetMinutes: 1.5,
      probes: [
        "Do you follow any kind of plan, or figure it out as you go?",
        "Is that a real decision you're making, or mostly just habit (or its absence) at this point?",
      ],
      note: "Trying to establish habit/inertia vs. genuine active decision-making -- that distinction matters a lot for whether a new tool would actually get adopted.",
    },
    {
      topic: "core barrier (forced choice)",
      ask:
        "If you had to pick just one — is the bigger reason you don't exercise more the time it takes, " +
        "not knowing what to actually do, or just not staying motivated? Pick one.",
      targetMinutes: 2,
      probes: [
        "Why that one over the other two?",
        "Tell me about a specific time that got in the way because of it.",
        "What would 'fixed' actually look like for you?",
      ],
      note:
        "This is the single most important question in the whole guide -- the answer decides whether " +
        "adaptive coaching (which mainly solves 'what to do') would move this person, or whether the " +
        "real problem is time or motivation that a smarter plan can't fix on its own. A vague 'a bit of " +
        "everything' answer isn't a real answer, worth pushing past.",
    },
    {
      topic: "satisfaction (rating + why)",
      ask: "On a scale of 1 to 10, how satisfied are you with how consistently you currently exercise?",
      targetMinutes: 1.5,
      rating: {
        prompt: "How satisfied are you with how consistently you currently exercise?",
        scale: "1 (not at all) to 10 (couldn't be better)",
      },
      probes: ["Why that number and not two points higher?", "What would move it up by even one point?"],
      note: "Get the number, then immediately probe the 'why' -- gauging real appetite for change vs. complacency.",
    },
    {
      topic: "unplanned thread (open-ended)",
      ask: "Tell me about a specific time you really meant to exercise and it just didn't happen, or a stretch where you fell off completely.",
      targetMinutes: 1.5,
      probes: ["What actually happened?", "Did it change how you approach it afterward?"],
      note:
        "Deliberately open-ended -- whatever story comes up here is worth actually pulling on for a turn " +
        "or two before moving on. A concrete falling-off moment here is often the real trigger that would " +
        "make someone try something new, worth more than a hypothetical.",
    },
    {
      topic: "Coach concept reaction",
      ask:
        "Here's an idea: imagine an app where an AI coach builds you a weekly workout plan and actually " +
        "adjusts it based on what you really did the week before — not a fixed program you either follow " +
        "or fall off of. Would you actually trust and try that, or not?",
      targetMinutes: 2,
      probes: [
        "What specifically would make you say yes, or what's holding you back?",
        "Would that actually solve the barrier you picked earlier, or not really?",
      ],
      note:
        "This is the direct payoff question the whole study exists to answer -- get a real yes/no-leaning " +
        "reaction and the concrete reason behind it, and explicitly connect it back to whichever barrier " +
        "they picked earlier (time/program-design/motivation) rather than treating it as a fresh question.",
    },
  ],
};

/**
 * Adapted from a client-supplied discussion guide for the oncologist TIH
 * pilot. Two structural adaptations were needed to fit this app's actual
 * capabilities, not just this guide's content:
 *
 * 1. No branching support -- GuideQuestion is a flat list the moderator
 *    reads in full every turn (see formatGuideForPrompt below), not a
 *    decision tree. The source guide's routing question (a "have you
 *    treated TIH" screen that sends the respondent down a direct-experience
 *    or no-experience follow-up) is expressed as ONE question whose `note`
 *    spells out both branches explicitly -- the moderator already handles
 *    conditional judgment this way for every other guide's probes.
 * 2. No visual/document display -- this is a voice-only call. The source
 *    guide's tap-to-answer scale questions became verbal `rating` fields
 *    (asked aloud, then probed why), matching every other guide's rating
 *    pattern. Its stimulus reveal ("[SHOW STIMULUS: tpp_unbranded]") has no
 *    equivalent at all -- there's no way to show a respondent a document
 *    mid-call -- so it became a placeholder to be READ aloud instead.
 *
 * NOT yet pilot-ready: the actual treatment-profile content (mechanism,
 * administration/monitoring, efficacy, safety incl. the allergic-type-
 * reaction subset) was referenced by the source guide's stimulus code but
 * never supplied -- only the code itself was. That content has to come from
 * the client; it is real clinical/efficacy/safety material that must not be
 * invented. See the "stimulus: treatment profile" question's `ask` field
 * below for the exact placeholder to replace.
 */
export const ONCOLOGY_TIH_GUIDE: Guide = {
  studyTopic:
    "How community oncologists handle referral of rare, complex tumor-associated conditions -- specifically " +
    "tumor-induced hyperinsulinism (TIH) -- and what it would take for them to manage such patients themselves " +
    "rather than refer them out.",
  targetDurationMinutes: 30,
  statedPurpose:
    "We're doing research on how oncologists in community practice make referral decisions for rare and " +
    "complex cases, including a condition called tumor-induced hyperinsulinism. There are no wrong answers " +
    "here -- we're just trying to understand how these decisions actually play out in real practice.",
  researchObjective:
    "You're being interviewed on behalf of a pharmaceutical company assessing the commercial and adoption " +
    "dynamics for an investigational treatment for tumor-induced hyperinsulinism (TIH), an ultra-rare " +
    "condition currently managed almost exclusively by referral to specialized centers of excellence (CoEs). " +
    "The company needs real answers to: (1) whether community oncologists would ever prescribe a new TIH " +
    "treatment themselves rather than refer, or whether referral is a fundamentally unmovable position for " +
    "this population; (2) what specific real-world evidence, track record, or messaging would actually move " +
    "that threshold, versus what's just a rationalization on top of an already-fixed clinical/relationship/ " +
    "economic instinct; (3) whether launching through a CoE-only channel at first would be a temporary phase " +
    "physicians would outgrow, or something that permanently entrenches the referral habit; (4) how referral-" +
    "relationship inertia and reimbursement/economics factor in versus purely clinical judgment. As the " +
    "evaluator, watch whether the moderator actually pins down concrete, forecast-usable answers to these -- " +
    "especially the track-record threshold and the always-refer-vs-movable question -- not just whether the " +
    "conversation feels pleasant.",
  openingScript:
    "Hi, thank you so much for making time today. I'm doing some research on how oncologists in community " +
    "practice handle referral decisions for rare and complex cases -- there are no wrong answers, I'm just " +
    "trying to understand how this actually works in your day-to-day practice. Ready to get started?",
  closingScript:
    "This has been genuinely useful, thank you for being so candid and for walking me through all of that. " +
    "That's everything I wanted to cover today -- have a great rest of your day.",
  questions: [
    {
      topic: "practice setting (community-practice screen)",
      ask: "To get us started, tell me a bit about your practice — what kind of setting do you work in?",
      targetMinutes: 1.5,
      goal:
        "Confirmed the respondent is community practice (not primarily academic/NCI-designated/COE), and have a " +
        "concrete sense of their setting and patient mix.",
      probes: ["What's your patient mix like?"],
      note:
        "Confirms the community-practice inclusion criterion. If setting is vague, gently confirm they're not " +
        "primarily at an academic medical center or NCI-designated/specialized center of excellence before moving on.",
    },
    {
      topic: "rare/complex case handling",
      ask: "When a rare or complex tumor-associated case comes along, well outside the usual, walk me through what typically happens next.",
      targetMinutes: 1.5,
      goal:
        "Have a concrete, specific account of what actually happens when a rare/complex case comes up, with the " +
        "refer/manage/co-manage instinct in their own words and whether it's driven by clinical judgment vs. " +
        "relationship/economics/inertia.",
      note:
        "Let refer/manage/co-manage emerge in their own words rather than naming a clean either/or. If they draw " +
        "a blank, concretize with a neutral example — but do NOT seed TIH. Flag whether any 'refer' instinct is " +
        "driven by clinical appropriateness vs. relationship/economics/inertia.",
    },
    {
      topic: "TIH familiarity",
      ask:
        "I'd like to talk about a condition called tumor-induced hyperinsulinism, or TIH — where certain tumors " +
        "cause severe, hard-to-control low blood sugar. How familiar are you with it? It's completely fine if " +
        "it's not something you see often.",
      targetMinutes: 1,
      goal: "Know their real level of familiarity with TIH, without them feeling judged for low familiarity.",
    },
    {
      topic: "TIH destination instinct (unprimed)",
      ask: "When a TIH case actually surfaces, where do you imagine that patient ends up being managed?",
      targetMinutes: 1,
      goal:
        "Captured their unprimed, honest first instinct on where TIH patients end up being managed, before " +
        "further discussion shapes it.",
      note:
        "Early, unprimed read on the open assumption that TIH patients go to centers of excellence — deeper " +
        "probing comes later, so capture the instinct here. A respondent who has seen a TIH patient can answer " +
        "from memory.",
    },
    {
      topic: "direct-experience routing (branches)",
      ask: "Have you ever personally treated or co-managed someone with TIH?",
      targetMinutes: 2.5,
      goal:
        "Established whether they've personally treated/co-managed a TIH patient, and -- for whichever track " +
        "applies -- have a concrete account: for direct experience, the last patient's management, their own " +
        "role, and what treatments were tried and how they held up; for no experience, a realistic walk-through " +
        "of how they'd approach such a patient.",
      note:
        "Routing question -- take exactly ONE of the two follow-ups below based on the answer, never both, and " +
        "skip the other track's questions later in this guide entirely (they're each labeled which track they " +
        "belong to). IF YES (direct-experience track): start with one open ask -- walk them through the last " +
        "TIH patient they encountered and how it was managed. Then, as SEPARATE follow-up turns, one at a time, " +
        "not combined: (a) what role did they personally play, including any referral that happened; (b) which " +
        "treatments were tried, including off-label options like steroids, octreotide, or pasireotide; (c) how " +
        "well those held up. IF NO (no-experience track): ask them to suppose a patient came in with severe, " +
        "hard-to-control hypoglycemia driven by their tumor, and walk through how they'd realistically approach " +
        "it — let treat-yourself vs. co-manage vs. send-out emerge naturally; this feeds the no-experience probe " +
        "on comfort taking such a patient on.",
    },
    {
      topic: "referral relationships",
      ask: "When you send a patient to a specialized center, how do those relationships actually work for you?",
      targetMinutes: 1.5,
      goal:
        "Understand, in their own words, how their referral relationships with specialized centers actually " +
        "work, including both what they get out of it and what it costs them (losing the patient, revenue) if " +
        "either comes up naturally.",
      note:
        "Opens the referral-relationship/CoE thread. Let both the value and the cost side (losing the patient, " +
        "revenue) emerge, but let them lead rather than forcing a two-part ask.",
    },
    {
      topic: "re-test destination instinct",
      ask: "Now that we've talked the referral picture through, does your earlier instinct about where TIH patients end up still hold, or has your thinking shifted?",
      targetMinutes: 1,
      goal: "Know whether their earlier destination instinct held or shifted after discussing referral relationships, and why.",
      note:
        "Anchor to the instinct captured at the 'TIH destination instinct' question earlier. Key re-test of the " +
        "open assumption that these patients are managed almost entirely at centers of excellence.",
    },
    {
      topic: "stimulus: treatment profile",
      // FICTIONAL PLACEHOLDER, not the client's real profile -- filled in
      // on request to make this guide testable end-to-end before the real
      // "tpp_unbranded" content exists. No real drug name, real trial data,
      // or real safety signal is represented here; every number and detail
      // below is invented for testing. MUST be swapped for the client's
      // actual profile text before this guide is used with a real
      // oncologist -- do not treat any of this as real clinical content.
      ask:
        "I'd like to walk you through a brief profile of an investigational treatment for tumor-induced " +
        "hyperinsulinism — take your time with the whole thing, and let me know when you've absorbed it. " +
        "This is a monoclonal antibody, given as a periodic IV infusion roughly once every four weeks in an " +
        "infusion-capable setting, that works by blocking excess insulin signaling directly at the receptor " +
        "level, rather than trying to shrink or remove the underlying tumor. Patients need routine blood " +
        "glucose monitoring around each infusion, plus standard infusion-reaction precautions. In an early-phase " +
        "study, about seven in ten patients reached stable, controlled blood sugar without needing rescue " +
        "glucose, typically within two to three infusions. The most common side effects were mild — infusion-" +
        "site reactions and transient fatigue — but a small subset, roughly one in twenty patients, had a " +
        "genuine allergic-type reaction requiring premedication or, in a couple of cases, discontinuation. " +
        "What's your overall first impression?",
      targetMinutes: 2,
      goal: "Confirmed they've absorbed the whole profile (mechanism, administration/monitoring, efficacy, safety) and captured a genuine first impression, not a rushed one.",
      note:
        "Get through the whole profile before asking for their impression -- mechanism, administration/" +
        "monitoring, efficacy, safety, all of it. Reminder for whoever maintains this guide: the `ask` text " +
        "above is a fictional placeholder (see the code comment on this question) and must be replaced with " +
        "the client's real treatment-profile content before any real oncologist call.",
    },
    {
      topic: "efficacy impression",
      ask: "What's your impression of the efficacy the profile describes?",
      targetMinutes: 1,
      goal: "Have their genuine read on the efficacy data specifically, without them jumping ahead to a refer-vs-prescribe verdict.",
      note:
        "Keep to their read of efficacy — resist a refer-vs-prescribe verdict here since admin and safety come " +
        "next. If they lean anyway, note it and say we'll return to the full picture.",
    },
    {
      topic: "safety impression incl. allergic reactions",
      ask: "What's your reaction to the safety picture, including the subset of patients with genuine allergic-type reactions?",
      targetMinutes: 1.5,
      goal: "Know how the safety picture overall, and the allergic-type-reaction subset specifically, actually affects their willingness to prescribe.",
      note:
        "The profile includes both manageable side effects and allergic-type reactions. Probe how the " +
        "allergic-type reactions specifically affect their own willingness to prescribe.",
    },
    {
      topic: "administration/monitoring feel (rating + why)",
      ask:
        "Now picture actually delivering this in your own setting — the periodic IV infusions, glucose " +
        "monitoring, watching for hypersensitivity. How manageable does that feel?",
      targetMinutes: 2,
      goal:
        "Have both a real verbal answer on how manageable the administration/monitoring burden feels in their " +
        "own setting, and the numeric rating, in that order.",
      rating: {
        prompt:
          "How comfortable would you feel managing the administration and monitoring described in this " +
          "treatment profile (periodic IV infusion, glucose monitoring, and watching for allergic-type " +
          "reactions) in your own community practice?",
        scale: "1 (not at all comfortable) to 5 (extremely comfortable)",
      },
      note:
        "Ask the open question verbally and get a real answer before asking for the rating number. Build on any " +
        "admin/monitoring concerns already surfaced. (Source guide presented this as a tap-to-answer 5-point " +
        "scale -- converted to a verbal ask since this app is voice-only.)",
    },
    {
      topic: "direct-experience counterfactual (direct-experience track only)",
      ask:
        "Thinking back to that specific patient — if a purpose-built treatment like this had existed then, " +
        "would you have kept them and managed them yourself, or still sent them out?",
      targetMinutes: 1.5,
      goal:
        "(Direct-experience track only.) Know whether they'd have kept and managed that specific past patient " +
        "themselves with this treatment available, or still referred, and the reasoning behind it.",
      note:
        "DIRECT-EXPERIENCE TRACK ONLY -- skip entirely for respondents who took the no-experience path at the " +
        "routing question earlier. Sharpest real-world adopt signal from direct-experience respondents. Push on " +
        "the reasoning.",
    },
    {
      topic: "track record needed to prescribe",
      ask: "For a treatment like this, what real-world track record would you need before you'd prescribe it yourself rather than refer?",
      targetMinutes: 2.5,
      goal:
        "Have a concrete answer covering duration, what specifically it would need to show (patient counts, " +
        "which safety signals resolved), and whose evidence would count (peers, published data, or the " +
        "centers) -- not a vague answer on any of these.",
      probes: [
        "How long would that track record need to be?",
        "What specifically would it need to show — patient counts, which safety signals resolved?",
        "Would that evidence need to come from peers, published data, or the centers themselves?",
      ],
      note:
        "MOST FORECAST-CRITICAL QUESTION in this guide -- protect its time even if running behind, and it's " +
        "worth spending it working through the probes above one at a time rather than rushing to the next topic.",
    },
    {
      topic: "likelihood to self-manage (rating + why)",
      ask: "If that track record existed, how likely would you be to take one of these patients on yourself?",
      targetMinutes: 1.5,
      goal:
        "Have the numeric rating, plus a concrete answer on what single thing would move them from referring to " +
        "prescribing, and whether that threshold is genuinely movable or effectively fixed.",
      rating: {
        prompt:
          "Assuming a strong multi-year real-world track record existed, how likely would you be to prescribe " +
          "an approved TIH treatment yourself rather than refer the patient to a specialized center?",
        scale: "1 (would always refer) to 5 (would definitely prescribe myself)",
      },
      probes: [
        "What single thing — a change to the profile, a person, or a moment — would actually move you from referring to prescribing?",
        "Is that threshold movable, or is this closer to an unmovable position?",
      ],
      note:
        "Ask verbally and get a real answer before asking for the rating number, then work through the probes " +
        "above one at a time. (Source guide presented this as a tap-to-answer 5-point scale -- converted to a " +
        "verbal ask, same as the administration/monitoring question above.)",
    },
    {
      topic: "reimbursement & economics",
      ask: "Setting the clinical side aside — how would the reimbursement and economics of taking a TIH patient on directly work in a practice like yours?",
      targetMinutes: 1.5,
      goal:
        "Understand how the economics would realistically work in their setting, and whether economics is a " +
        "genuine barrier or a rationalization sitting on top of an already-fixed clinical/relationship instinct.",
      probes: [
        "Would this run through buy-and-bill, or specialty pharmacy?",
        "What would the infusion cost and staffing look like in your setting?",
        "How much reimbursement risk would you be taking on for an ultra-rare drug like this?",
      ],
      note:
        "Listen for whether economics is a genuine barrier or a rationalization on a clinical/relationship " +
        "instinct. Keep at the level they can speak to.",
    },
    {
      topic: "CoE-only launch: temporary vs. entrenching",
      ask:
        "A treatment like this would likely launch only through a handful of specialized centers at first. Do " +
        "you see that CoE-only starting point as a temporary phase you'd outgrow, or something that would " +
        "entrench referring these patients out permanently?",
      targetMinutes: 1.5,
      goal: "Know whether they see a CoE-only launch as a phase they'd outgrow or something that permanently entrenches the referral habit, with their reasoning.",
      note:
        "Top-tier strategic insight. Listen for temporary-phase vs. permanent-entrenchment framing and whether " +
        "an initial CoE-only channel hardens the referral habit for good.",
    },
    {
      topic: "awareness/diffusion channel",
      ask: "How would you first even become aware that a treatment like this had built up a track record worth reconsidering?",
      targetMinutes: 1,
      goal: "Know both how they'd realistically become aware of a track record worth reconsidering, and roughly how long after launch that awareness would reach them.",
      probes: ["About how long after launch would that reach you?"],
      note: "WHO-informs-me / diffusion angle.",
    },
    {
      topic: "relationship inertia",
      ask: "How much does simply not wanting to break an established, trusted handoff with a center factor into whether you'd take one of these patients on yourself?",
      targetMinutes: 1,
      goal: "Know how much simply not wanting to disrupt an established, trusted referral relationship factors into their own self-adoption decision, distinct from clinical or economic reasoning.",
      note:
        "Anchor to the referral relationships they described earlier. The distinct thing here is relationship " +
        "inertia as a deterrent to self-adoption specifically.",
    },
    {
      topic: "always-refer capstone",
      ask: "Some physicians tell us that for a condition this rare, they'd always refer these patients out no matter what evidence emerged. Where do you land?",
      targetMinutes: 1.5,
      goal: "Have a clear position on always-refer vs. movable-threshold, with the actual reasoning underneath it, in their own words.",
      probes: ["What's the reasoning behind that?"],
      note:
        "Dedicated capstone on 'always refer' vs. movable-threshold. Reference any earlier lean and push for the " +
        "reasoning underneath. Capture, in their own words, what an unmovable position sounds like or what " +
        "would genuinely move them.",
    },
    {
      topic: "messaging/framing needed",
      ask: "Beyond the raw data — what would a profile, or the people presenting it, actually need to say to earn your confidence enough to consider prescribing?",
      targetMinutes: 1,
      goal: "Know specifically what a profile or the people presenting it would need to say to earn enough confidence to consider prescribing, including how the safety picture should be framed.",
      note:
        "Messaging/communication angle. Steer toward how the offering must frame itself, especially the honest " +
        "but imperfect safety picture — what reassurances resonate vs. ring hollow.",
    },
    {
      topic: "forward-looking synthesis",
      ask: "Before we wrap, in a sentence or two, where do you land overall on who should be managing these patients going forward?",
      targetMinutes: 1,
      goal: "Have a clean, quotable, forward-looking statement in their own words on who should be managing these patients going forward.",
      note:
        "Forward-looking synthesis of the whole conversation, not a re-litigation of the always-refer capstone. " +
        "Aim for a clean, quotable summation in their own language.",
    },
    {
      topic: "anything else + close",
      ask: "Is there anything we haven't touched on that you think matters to this decision?",
      targetMinutes: 0.5,
      goal: "Given them a genuine opportunity to raise anything unaddressed, then closed warmly.",
      note: "Then thank them warmly for their time.",
    },
  ],
};

/** Every guide the app can run, keyed by the name used in the manual-test
 * UI, the ElevenLabs agent's baked-in webhook URL, and conversation_state's
 * stored `guide` column. */
export const GUIDES: Record<string, Guide> = {
  everyday: EVERYDAY_GUIDE,
  commute: COMMUTE_GUIDE,
  streaming: STREAMING_GUIDE,
  fitness: FITNESS_GUIDE,
  biopharma: BIOPHARMA_GUIDE,
  oncology_tih: ONCOLOGY_TIH_GUIDE,
};

export function getGuide(name: string): Guide | undefined {
  return GUIDES[name];
}

export function formatGuideForPrompt(guide: Guide): string {
  return guide.questions
    .map((q, i) => {
      const parts = [`${i + 1}. [${q.topic}, ~${q.targetMinutes} min]`, q.ask];
      if (q.goal) {
        parts.push(
          `[GOAL: ${q.goal} -- keep probing this topic, one thing at a time, drawing on the probes below if helpful, ` +
            `until this is genuinely satisfied, or until you're clearly out of time for it relative to its time budget ` +
            `above and the overall pacing note -- whichever comes first. A scripted probe list is not itself the goal.]`
        );
      }
      if (q.rating) {
        parts.push(`Also ask them to rate it verbally — "${q.rating.prompt}" — ${q.rating.scale} — and get the number.`);
      }
      // The reminder is appended here, at render time, rather than typed
      // into every question's probes/note text -- guarantees it reaches
      // every question in every guide (present and future) and can't drift
      // out of sync one question at a time. Deliberately repeated at BOTH
      // spots rather than said once: the whole guide renders into the
      // moderator's prompt every single turn, not paginated by "current
      // question," so a reminder placed anywhere in this function reaches
      // every turn -- repeating it at every probes/note occurrence is what
      // makes it land near the exact spot compounding risk actually shows
      // up, not a generic rule stated once and forgotten by turn 10.
      if (q.probes?.length) {
        parts.push(
          `(probes if needed, one at a time across separate turns -- never combine two of these into a single compound question: ${q.probes.join("; ")})`
        );
      }
      if (q.note) parts.push(`[${q.note} Ask one thing at a time here -- never combine multiple asks into a single compound question.]`);
      return parts.join(" ");
    })
    .join("\n");
}
