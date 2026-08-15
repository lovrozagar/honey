import "reflect-metadata"
import {
	Controller,
	Get,
	Injectable,
	Req,
	type MiddlewareConsumer,
	Module,
	type NestMiddleware,
	type NestModule,
	Param,
} from "@nestjs/common"
import { NestFactory } from "@nestjs/core"
import type { NextFunction, Request, Response } from "express"

type TimedRequest = Request & { startedAt: number }

@Injectable()
class TimingMiddleware implements NestMiddleware {
	use(req: TimedRequest, _res: Response, next: NextFunction) {
		req.startedAt = performance.now()
		next()
	}
}

@Controller()
class AppController {
	@Get("json")
	json() {
		return { message: "Hello, World!" }
	}

	@Get("params/:id")
	params(@Param("id") id: string) {
		return { id }
	}

	@Get("middleware")
	middleware(@Req() req: TimedRequest) {
		return { elapsed: performance.now() - req.startedAt }
	}
}

@Module({ controllers: [AppController] })
class AppModule implements NestModule {
	configure(consumer: MiddlewareConsumer) {
		consumer.apply(TimingMiddleware).forRoutes("middleware")
	}
}

const port = Number(process.env.PORT ?? 3104)
const app = await NestFactory.create(AppModule, { logger: false })
await app.listen(port, "0.0.0.0")
console.log(`nest on :${port}`)
