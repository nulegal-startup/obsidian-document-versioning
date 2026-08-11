export function activateReviewCenter(render: () => void, refresh: () => Promise<void>): void {
	render();
	void refresh();
}

export class ReviewRefreshGate<T> {
	private inFlight?: { key: string; promise: Promise<T> };

	run(key: string, request: () => Promise<T>): Promise<T> {
		if (this.inFlight?.key === key) return this.inFlight.promise;
		if (this.inFlight) {
			const previous = this.inFlight.promise;
			return previous.then(
				() => this.run(key, request),
				() => this.run(key, request),
			);
		}

		let current: Promise<T>;
		try {
			current = request();
		} catch (error) {
			return Promise.reject(error);
		}
		this.inFlight = { key, promise: current };
		const clear = (): void => {
			if (this.inFlight?.promise === current) this.inFlight = undefined;
		};
		void current.then(clear, clear);
		return current;
	}
}
