export interface KimiEnvironmentQuiescentAuxiliaryRunner {
  quiesceForEnvironmentChange(): Promise<void>;
}

export interface KimiEnvironmentTransition {
  release(): Promise<void>;
}

export interface KimiAuxiliaryLifecycleOptions {
  lifecycle?: KimiAuxiliaryLifecycleCoordinator;
  resolveLifecycle?: () => Promise<KimiAuxiliaryLifecycleCoordinator>;
}

interface TransitionGate {
  finishTransition(): void;
  open: boolean;
  opened: Promise<void>;
  openGate(): void;
}

function createTransitionGate(finishTransition: () => void): TransitionGate {
  let openGate!: () => void;
  const opened = new Promise<void>(resolve => { openGate = resolve; });
  return {
    finishTransition,
    open: false,
    opened,
    openGate,
  };
}

export class KimiAuxiliaryLifecycleCoordinator {
  private activeGate: TransitionGate | null = null;
  private disposed = false;
  private readonly runners = new Set<WeakRef<KimiEnvironmentQuiescentAuxiliaryRunner>>();
  private transitionTail: Promise<void> = Promise.resolve();

  async acquire(
    runner: KimiEnvironmentQuiescentAuxiliaryRunner,
    signal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Cancelled');
      }
      if (this.disposed) {
        throw new Error('Kimi auxiliary services are disposed.');
      }
      const gate = this.activeGate;
      if (gate) {
        await this.waitForGate(gate, signal);
        continue;
      }
      this.track(runner);
      return;
    }
  }

  acquireOwned(runner: KimiEnvironmentQuiescentAuxiliaryRunner): void {
    if (this.disposed) {
      throw new Error('Kimi auxiliary services are disposed.');
    }
    this.track(runner);
  }

  private async waitForGate(gate: TransitionGate, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await gate.opened;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort);
        reject(new Error('Cancelled'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void gate.opened.then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  track(runner: KimiEnvironmentQuiescentAuxiliaryRunner): void {
    if (this.findReference(runner)) {
      return;
    }
    this.runners.add(new WeakRef(runner));
  }

  untrack(runner: KimiEnvironmentQuiescentAuxiliaryRunner): void {
    const reference = this.findReference(runner);
    if (reference) {
      this.runners.delete(reference);
    }
  }

  async beginEnvironmentChange(): Promise<KimiEnvironmentTransition> {
    if (this.disposed) {
      throw new Error('Kimi auxiliary services are disposed.');
    }

    let finishTransition!: () => void;
    const transitionFinished = new Promise<void>(resolve => { finishTransition = resolve; });
    const previousTransition = this.transitionTail;
    this.transitionTail = previousTransition.then(() => transitionFinished);
    await previousTransition;

    if (this.disposed) {
      finishTransition();
      throw new Error('Kimi auxiliary services are disposed.');
    }

    const gate = createTransitionGate(finishTransition);
    this.activeGate = gate;
    const release = async (): Promise<void> => {
      if (gate.open) {
        return;
      }
      gate.open = true;
      if (this.activeGate === gate) {
        this.activeGate = null;
      }
      gate.openGate();
      gate.finishTransition();
    };

    try {
      await Promise.all(this.getActiveRunners().map(
        runner => runner.quiesceForEnvironmentChange(),
      ));
      if (this.disposed) {
        throw new Error('Kimi auxiliary services are disposed.');
      }
      return { release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    const transition = await this.beginEnvironmentChange();
    await transition.release();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const gate = this.activeGate;
    if (gate && !gate.open) {
      gate.open = true;
      this.activeGate = null;
      gate.openGate();
      gate.finishTransition();
    }
    await Promise.allSettled(this.getActiveRunners().map(
      runner => runner.quiesceForEnvironmentChange(),
    ));
    this.runners.clear();
  }

  private getActiveRunners(): KimiEnvironmentQuiescentAuxiliaryRunner[] {
    const activeRunners: KimiEnvironmentQuiescentAuxiliaryRunner[] = [];
    for (const reference of this.runners) {
      const runner = reference.deref();
      if (runner) {
        activeRunners.push(runner);
      } else {
        this.runners.delete(reference);
      }
    }
    return activeRunners;
  }

  private findReference(
    runner: KimiEnvironmentQuiescentAuxiliaryRunner,
  ): WeakRef<KimiEnvironmentQuiescentAuxiliaryRunner> | null {
    for (const reference of this.runners) {
      const current = reference.deref();
      if (!current) {
        this.runners.delete(reference);
      } else if (current === runner) {
        return reference;
      }
    }
    return null;
  }
}
