---
name: pathlight-behavior
description: Use when the user wants a state diagram or flow of what a user sees or what a feature does ("draw the flow", "statechart", "what should happen when..."), to find where a flow breaks, or to mark which states are broken or fixed in pathlight. Writes a behavior view in a *.behavior.c4 file and shows it with pathlight.
---

# pathlight behavior

A behavior view answers "what should happen, step by step?" It is a state diagram you write from reading the code, drawn in the same LikeC4 workspace as the architecture and opened with `pathlight show`. The architecture map is scanned from the code; this is not. It is **your reading of the code**, so say so, and never present it as verified.

## Truthfulness

- A behavior view is a claim, not an observation. Every state and transition must come from code you read, and each state names the files it comes from (see below). Do not invent a state to make the picture complete. Leave a gap and say what you could not find.
- Finding a bug means reasoning through the transitions and seeing one that gives the wrong result for the user, or a combination of events nobody handled. Say what you traced and what you did not. A formal checker (TLA+ or another) finds more, but it is optional and you must not assume one is installed.
- Never change product code because a diagram looks wrong unless the user asks. Report the bug in plain words, as the steps that lead to it.

## Where it goes

Write one file per flow in the workspace root, named `NAME.behavior.c4` (for example `messages.behavior.c4`). `pathlight draft` leaves these alone, so a rerun never loses them. If the project has no model at all, ask before creating `likec4.config.json` and `pathlight.activity.json` (see the pathlight skill).

Put one flow in one `flow` element, tagged `#behavior`, with its states inside it, and name the flow after what it is (`signup`), because top-level ids are shared with the generated architecture model and a clash stops it compiling. Declare `tag behavior` in the file's `specification`, as the example does: it keeps the flow out of the architecture views. Avoid LikeC4 reserved words as ids (`storage`, `notation`, `model`, `view`, `style`, `group`).

```likec4
specification {
  element flow
  element state
  element decision
  tag behavior
  tag bug
  tag fixed
}
model {
  signup = flow 'Signing up' {
    #behavior
    start = state 'Someone opens the sign-up page' {
      description 'src/web/signup.ts'
    }
    taken = decision 'Is the email already used?'
    error = state 'They see "email taken"' {
      #fixed
      description 'src/web/signup.ts, src/api/users.ts'
    }
    created = state 'Account created, welcome email sent'
    double = state 'Two accounts exist for one email' {
      #bug
      description 'Two requests at once both pass the check. src/api/users.ts'
    }
    start -> taken 'submits the form'
    taken -> error 'yes'
    taken -> created 'no'
    taken -> double 'no, and a second request arrives first'
  }
}
views {
  view signup of signup {
    title 'What happens when someone signs up'
    description 'Agent-written from src/api/users.ts and src/web/signup.ts. Synced at 3f2a9c1.'
    include *
    autoLayout TopBottom
  }
}
```

## How to draw it

1. **States are what the person sees**, in their words ("Your phone buzzes after you opened it"), not function names. A state is a place the flow rests; a `decision` is a question with two or more answers.
2. **Transitions are the events**, written on the arrow as the title ("you walk away without reading it"). One transition per cause. If one cause can lead to two states, draw a decision.
3. **Start from the real code path.** Read the handlers and follow each branch. Draw the ordinary path first, then the unusual ones (retries, two things at once, going offline, an expired session).
4. **Keep it small.** Roughly 8 to 25 boxes. Split a flow that needs more into two views linked with `navigateTo`.
5. **Say where each state lives.** Put the files in its `description`, as the example does. This is how someone reviewing the diagram opens the code.

## Marking findings

- A state the user should not be able to reach, or that gives the wrong result, gets `#bug`. Its description says in one sentence why it happens.
- Once the code is changed and you have read the changed code, add a `#fixed` state next to it showing the corrected outcome, linked from the bug with a transition titled `with the fix`. Leave the `#bug` state in so the history reads.
- No tag means "traced, and it works". It does not mean tested.

pathlight draws `#bug` boxes with a red outline and `#fixed` ones green.

## Keeping it true

- Write the commit you read the code at into the view's `description` (`Synced at <short sha>`), as the example does. Get it with `git rev-parse --short HEAD`.
- Before using or extending a behavior view, run `git diff --stat SYNC_SHA -- FILES` over the files its states name. If anything changed, re-read those parts and update the view, and only then move the sync commit forward.
- Say plainly when you did not do that: "this diagram was last checked at <sha>".

## Show it

`pathlight show VIEW --workspace . --follow` with the view id (`signup` above). `pathlight list --workspace .` lists every view. The relationship titles (the events) appear in the inspector under Connections when a box is selected; the diagram itself draws no text on arrows, so make each state name read on its own.
