---
title: The Velocity Trap
description: Systems optimised for writing become archaeology for the people who read them later. That cost is quiet, it compounds, and it is going up a gear.
author: "John Smith"
date: 2026-11-24
---

[Joel Spolsky said it](https://www.joelonsoftware.com/2000/04/06/things-you-should-never-do-part-i/) in 2000: it's harder to read code than to write it. Nobody disagreed. Nobody did much about it either.

That asymmetry has always been there. What's changed is the scale at which we now produce the writing, and how far we've moved the people doing it from the people who'll eventually have to read it.

## This isn't a new argument. It's a louder one.

In 2016 Brad Frost named something practitioners already knew: that [frontend design](https://bradfrost.com/blog/post/frontend-design/) lives between design and engineering, done by people who think in HTML, CSS, accessibility and interaction, alongside people who think in data, state, APIs and system behaviour. Different minds, different instincts, both called the same thing.

It was a precise observation. It suggested, without quite saying it, that respecting that division might produce better outcomes, for the people and for the systems they built.

Three years later Chris Coyier named what happened instead, in [The Great Divide](https://css-tricks.com/the-great-divide/). The gap hadn't closed. It had widened, and the industry hadn't resolved the tension so much as accelerated it, leaving a generation of developers uncertain about where they stood, what they were supposed to know, which half of the divide they even belonged to.

Both pieces were describing a human problem of identity, craft and belonging. Neither named the structural cost underneath it.

The divide wasn't respected, and it wasn't resolved. One half of it became the default. In the terms Frost [later gave the two halves](https://bradfrost.com/blog/post/front-of-the-front-end-and-back-of-the-front-end-web-development/), the back of the front end came forward. The tools and instincts of application engineering moved into the interface, and the component tree became the host of everything: markup, styling, data fetching, auth, error handling, server logic. The people who thought in HTML and CSS argued against it at the time. Their craft came to be treated as something to abstract away rather than something to know, and the implicit message became that everyone just needs to understand all of it now, and the abstraction will hold.

That's a reading of what happened, and not the only one. What it left behind is easier to agree on. We didn't just unify those concerns. We lost the boundaries that had made systems legible in the first place. The divide wasn't only a people problem; it was an architectural one, and flattening it didn't reduce the complexity. It made the complexity harder to see.

And so we built, quickly, reasonably and in good faith.

## Nobody made a bad decision

This is the part that always gets left out.

The component model was genuinely good. Composable, testable, portable, hireable. It made hard things tractable and let small teams build things that used to need much larger ones.

Every individual choice made sense. Fetch here, because this component needs it. Handle the error here, because this is where it surfaces. Check the permission here, because this is where the context lives. Locally reasonable, every one of them, and documented, reviewed and approved.

Take an order history page. The account layout checks who's signed in, the list fetches their orders, and each row asks whether its order can still be cancelled. If that last lookup fails, the row hides the cancel button and the rest of the page loads. Each of those was a sensible call where it was made.

The velocity was real. The features shipped and the companies grew.

We built this together. Developers, tech leads, framework authors, the whole ecosystem that rewarded shipping above everything else. Every incentive pointed in the same direction and we followed it, because that's what reasonable people do.

What we didn't notice, and what the system made very easy not to notice, was what was accumulating quietly on the other side of all those reasonable decisions.

## What the bill actually looks like

It doesn't arrive as a crisis. There's no outage, no breaking change, no moment where everything stops.

It arrives as a question that should take five minutes and takes a morning. An onboarding process measured in weeks. A debugging session where understanding what's happening requires tracing the execution path of a single request across a codebase that has never, in any one place, described what it actually does.

A customer says the cancel button is missing from one of their orders. Nothing failed loudly; the page loaded. To answer, somebody has to follow the request from the layout down to the row.

A trace would help, if that lookup was instrumented and the trace was kept. It would show what one request did. It would not show what the page was meant to do.

The execution plan exists. It's just not anywhere in particular. It's distributed across however many components deep the render goes, assembled implicitly by whatever the tree happens to do when it runs.

The system was optimised for writing. Nobody optimised it for reading, and those aren't the same thing. That doesn't matter on the day you ship, and it compounds quietly every day after.

At scale, in a codebase that's grown organically over eighteen months of individually sensible decisions, understanding it requires running it in your head. That's not a technical problem. That's an archaeological one.

And here's the thing about archaeology. It takes time that wasn't budgeted, from people who weren't there, to understand decisions that made complete sense at the time and left no forwarding address.

It's not only the execution plan that disappears, either. It's the reasoning. Why this approach and not another. What was tried first. What the business was actually trying to solve when the ticket was raised. That thinking lived in someone's head, or in a Jira ticket three reorganisations old, or in a commit message that just says "fix". The code can eventually yield its what. The why is usually gone, the moment the person who held it moved on to the next job, the next company, the next rewrite.

Ship a feature in two days and leave days of archaeology for the next person. That's not velocity. That's velocity borrowed at a high interest rate, and like all high interest debt, repayment arrives at the worst possible time.

Most of the people who made those decisions knew, somewhere, that the cost existed. They shipped anyway, because the system didn't give them another option.

## The cycle nobody talks about honestly

The ecosystem self-corrects, the argument goes. Better abstractions arrive. The industry learns.

Partly true. Also slightly dishonest.

The ecosystem doesn't self-correct. It self-replaces. Those are different things.

Self-correction would mean going back into the existing codebases and dealing with what accumulated. What actually happens is that a new framework arrives, or worse, the one you built on changes fundamentally beneath you. It rewrites its mental model, breaks its own conventions, deprecates the patterns your team standardised on two years ago. Suddenly the migration isn't optional. It's a forced march dressed up as progress, paid for by people who weren't there for the original decisions and didn't sign up for the new direction.

Either way, what accumulated stays. Someone maintains it, usually someone who wasn't there when the decisions were made, working in a system that's neither the old thing nor the new thing and understanding neither completely. They learn the archaeology. They make their own reasonable decisions on top of it.

The cycle continues. Build fast. Ship. Slow down. Rewrite or migrate. New framework this time. Build fast again.

Each iteration is genuinely faster at the start. The tooling improves, the DX improves, the starting point keeps moving. The ending point looks familiar.

Nobody planned this and nobody is to blame for it. It emerged from thousands of individually sensible decisions made by people trying to do good work under real constraints, which is exactly what makes it worth looking at honestly rather than absorbing as the cost of doing business.

## The question that doesn't get asked

The questions that do get asked are how fast we can ship, which framework has the best DX, and whether this component makes sense in isolation. The one that doesn't is who will be reading this in eighteen months, and what it will cost them to understand it.

No clean answer exists. Velocity is real, debt is real, and every team is trading one against the other with incomplete information and real time pressure. That won't change and probably shouldn't.

But there's a version of that tradeoff made consciously, where the people making architectural decisions are at least thinking about the people who'll live with them. And there's a version where the cost stays invisible until it isn't, absorbed quietly by whoever's at the keyboard when the bill arrives.

Brad Frost named the space between design and engineering where frontend work lives. Chris Coyier named the divide that opened inside it. What sits underneath both, and what the industry has been working around without quite saying, is that the abstraction we reached for to bridge that divide also made it very easy to distribute cost in ways that don't show up until later, in places where the original decisions are no longer visible.

That's not an accusation. It's a description of something we built together and are all, in various ways, living inside.

## Why it matters more now than it did yesterday

Because the next layer is arriving.

AI tooling is making the component model more productive than it's ever been. Code that took days takes hours. Features that needed senior engineers get scaffolded by juniors with the right prompt. The velocity is genuinely increasing.

Which means the accumulation is increasing too. Faster in, faster distributed, faster invisible. The time saved writing is easy to see. The work of piecing it together later is still somebody else's morning.

And there's something new in this layer. With generated code, it's easier for a default to become a decision without anyone discussing it. A prompt can produce the list, the rows and the error handling before anyone has asked what should happen when the lookup fails.

Some will say AI will read the codebase for you. It can. An AI can trace the missing button back to the failed lookup. Why hide it from the customer instead of telling them to try again? That reason may never have made it into the code or the review. Maybe nobody asked.

An AI explaining sediment is still archaeology, just faster.

We're making a collective decision about this right now, not in any single meeting but in aggregate, through the tools we reach for, the patterns we reward and the questions we remember to ask.

The one worth keeping visible is simple. Can someone understand what this does without having to read all of it?

Not a standard every codebase has to meet. Just a thing worth caring about, alongside velocity, alongside DX, alongside everything else already being measured.

The people who'll be asking it aren't here yet. They'll arrive in eighteen months, or two years, or whenever the next rewrite begins, voluntary or forced.

They'll be asking in good faith, the same way we built in good faith.

The question is whether we leave them a system, or a dig site.

---

*For how τjs makes the initial request easier to follow, see [Where a page decides what it needs](/articles/where-a-page-decides/).*
