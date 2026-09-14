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

/** Every guide the app can run, keyed by the name used in the manual-test
 * UI, the ElevenLabs agent's baked-in webhook URL, and conversation_state's
 * stored `guide` column. */
export const GUIDES: Record<string, Guide> = {
  everyday: EVERYDAY_GUIDE,
  commute: COMMUTE_GUIDE,
  streaming: STREAMING_GUIDE,
  fitness: FITNESS_GUIDE,
  biopharma: BIOPHARMA_GUIDE,
};

export function getGuide(name: string): Guide | undefined {
  return GUIDES[name];
}

export function formatGuideForPrompt(guide: Guide): string {
  return guide.questions
    .map((q, i) => {
      const parts = [`${i + 1}. [${q.topic}, ~${q.targetMinutes} min]`, q.ask];
      if (q.rating) {
        parts.push(`Also ask them to rate it verbally — "${q.rating.prompt}" — ${q.rating.scale} — and get the number.`);
      }
      if (q.probes?.length) parts.push(`(probes if needed: ${q.probes.join("; ")})`);
      if (q.note) parts.push(`[${q.note}]`);
      return parts.join(" ");
    })
    .join("\n");
}
